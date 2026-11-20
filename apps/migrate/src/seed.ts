import { randomBytes, scryptSync } from 'node:crypto';
import pg from 'pg';

/**
 * Bulk, set-based seed (generate_series / INSERT ... SELECT, never row by row):
 * 50 000 buyers + staff, 30 venues (venue 1 = 10 000 seats + 2 000-capacity dancefloor), 2 000 events and ~1 000 000
 * sold tickets with matching orders, payments, seat holds and balanced double-entry ledger postings.
 * Idempotent: guarded by `seed_runs('seed-v1')` and an advisory lock; the whole seed is one transaction.
 */
export const SEED_NAME = 'seed-v1';

/** Same format as `@tickets/shared/password` (`scrypt$<salt>$<hash>`, N=16384 r=8 p=1, 32 bytes). */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

const STEPS: { name: string; sql: string }[] = [
  {
    name: 'buyers',
    sql: `INSERT INTO users (email, password_hash, name, role, locale)
          SELECT 'buyer' || n || '@example.com', $1, 'Buyer ' || n, 'buyer', (ARRAY['uk','en','pl'])[1 + n % 3]
          FROM generate_series(1, 50000) n`,
  },
  {
    name: 'staff',
    sql: `INSERT INTO users (email, password_hash, name, role, locale) VALUES
          ('organizer1@example.com', $1, 'Organizer One', 'organizer', 'uk'),
          ('organizer2@example.com', $1, 'Organizer Two', 'organizer', 'en'),
          ('controller1@example.com', $1, 'Controller One', 'controller', 'uk'),
          ('controller2@example.com', $1, 'Controller Two', 'controller', 'pl'),
          ('finance1@example.com', $1, 'Finance One', 'finance', 'uk')`,
  },
  {
    name: 'buyer index',
    sql: `CREATE TEMP TABLE seed_buyers AS
          SELECT substring(email FROM 6 FOR position('@' IN email) - 6)::int AS idx, id FROM users WHERE role = 'buyer'`,
  },
  { name: 'buyer index pk', sql: `CREATE UNIQUE INDEX ON seed_buyers (idx)` },
  {
    name: 'venues',
    sql: `CREATE TEMP TABLE seed_venues AS SELECT v AS n, gen_random_uuid() AS id FROM generate_series(1, 30) v`,
  },
  {
    name: 'venues insert',
    sql: `INSERT INTO venues (id, organizer_id, name, city, layout)
          SELECT sv.id,
                 (SELECT id FROM users WHERE email = CASE WHEN sv.n <= 15 THEN 'organizer1@example.com' ELSE 'organizer2@example.com' END),
                 CASE WHEN sv.n = 1 THEN 'Arena Kyiv (10 000 seats)' ELSE 'Hall ' || sv.n END,
                 (ARRAY['Kyiv','Lviv','Odesa','Kharkiv','Dnipro','Warsaw','Krakow','Gdansk'])[1 + sv.n % 8],
                 '{}'::jsonb
          FROM seed_venues sv`,
  },
  {
    name: 'zones plan',
    sql: `CREATE TEMP TABLE seed_zones AS
          SELECT gen_random_uuid() AS id, sv.id AS venue_id, sv.n AS vn, z.name, z.kind::zone_kind AS kind,
                 z.capacity, z.nrows, z.per_row, z.y_off, z.ord
          FROM seed_venues sv CROSS JOIN LATERAL (
            SELECT * FROM (VALUES
              ('Stalls', 'seated', NULL::int, CASE WHEN sv.n = 1 THEN 60 ELSE 20 END, CASE WHEN sv.n = 1 THEN 100 ELSE 30 END, 0, 1),
              ('Balcony', 'seated', NULL::int, CASE WHEN sv.n = 1 THEN 40 ELSE 10 END, CASE WHEN sv.n = 1 THEN 100 ELSE 20 END, CASE WHEN sv.n = 1 THEN 62 ELSE 22 END, 2),
              ('Dancefloor', 'dancefloor', CASE WHEN sv.n = 1 THEN 2000 ELSE 300 END, 0, 0, 0, 3)
            ) AS t (name, kind, capacity, nrows, per_row, y_off, ord)
            WHERE t.kind = 'seated' OR sv.n = 1 OR sv.n % 5 = 0
          ) z`,
  },
  {
    name: 'zones insert',
    sql: `INSERT INTO zones (id, venue_id, name, kind, capacity) SELECT id, venue_id, name, kind, capacity FROM seed_zones`,
  },
  {
    name: 'seats',
    sql: `INSERT INTO seats (venue_id, zone_id, row_label, seat_number, x, y)
          SELECT z.venue_id, z.id, 'R' || r, s, (s - 1)::real, (z.y_off + r - 1)::real
          FROM seed_zones z, LATERAL generate_series(1, z.nrows) r, LATERAL generate_series(1, z.per_row) s
          WHERE z.kind = 'seated'
          ORDER BY z.venue_id, z.ord, r, s`,
  },
  {
    name: 'seat rank',
    sql: `CREATE TEMP TABLE seed_seats AS
          SELECT id, venue_id, zone_id, row_number() OVER (PARTITION BY venue_id ORDER BY id) AS rn FROM seats`,
  },
  { name: 'seat rank idx', sql: `CREATE UNIQUE INDEX ON seed_seats (venue_id, rn)` },
  {
    // E-BIG (1), E-QUEUE (2), E-SOLDOUT (3), E-CANCEL (4) are fixed; the rest is generated.
    name: 'events plan',
    sql: `CREATE TEMP TABLE seed_events AS
          SELECT q.*,
                 CASE q.i WHEN 1 THEN now() + interval '30 days' WHEN 2 THEN now() + interval '14 days'
                          WHEN 3 THEN now() + interval '20 days' WHEN 4 THEN now() + interval '45 days'
                          ELSE CASE WHEN q.st = 'finished' THEN now() - ((5 + q.i % 25) * interval '1 day')
                                    ELSE now() + ((1 + q.i % 180) * interval '1 day') + (q.i % 24) * interval '1 hour' END END AS starts_at,
                 CASE WHEN q.i = 2 OR (q.i > 4 AND q.st = 'on_sale' AND q.i % 40 = 11) THEN now() + interval '10 minutes' END AS sales_start
          FROM (
            SELECT i, gen_random_uuid() AS id,
                   CASE i WHEN 1 THEN 1 WHEN 2 THEN 1 WHEN 3 THEN 2 WHEN 4 THEN 1 ELSE 1 + i % 30 END AS vn,
                   CASE WHEN i = 3 THEN 'sold_out' WHEN i <= 4 THEN 'on_sale' WHEN i % 50 = 7 THEN 'draft'
                        WHEN i % 20 = 0 THEN 'finished' ELSE 'on_sale' END AS st
            FROM generate_series(1, 2000) i
          ) q`,
  },
  {
    name: 'events insert',
    sql: `INSERT INTO events (id, code, organizer_id, venue_id, title, category, city, starts_at, ends_at, status,
                             sales_start, per_user_limit, queue_enabled)
          SELECT e.id,
                 CASE e.i WHEN 1 THEN 'E-BIG' WHEN 2 THEN 'E-QUEUE' WHEN 3 THEN 'E-SOLDOUT' WHEN 4 THEN 'E-CANCEL' END,
                 v.organizer_id, v.id,
                 CASE e.i WHEN 1 THEN 'Big Arena Show' WHEN 2 THEN 'Queue Night Live' WHEN 3 THEN 'Sold Out Gala' WHEN 4 THEN 'Cancelled Festival'
                   ELSE (ARRAY['Aurora','Neon Skyline','The Parallels','Kyiv Symphony','Blue Hour','Okean','Lviv Jazz Quartet','Midnight Express'])[1 + e.i % 8]
                        || ' - Tour ' || e.i END,
                 (ARRAY['concert','theatre','festival','standup','opera'])[1 + e.i % 5],
                 v.city, e.starts_at, e.starts_at + interval '3 hours', e.st::event_status, e.sales_start, 6, e.i = 2
          FROM seed_events e JOIN venues v ON v.id = (SELECT id FROM seed_venues WHERE n = e.vn)`,
  },
  {
    name: 'zone prices',
    sql: `INSERT INTO event_zone_prices (event_id, zone_id, price_kop)
          SELECT e.id, z.id, (300 + ((e.i * 13 + z.ord * 7) % 20) * 50)::bigint * 100
          FROM seed_events e JOIN seed_zones z ON z.vn = e.vn WHERE e.st <> 'draft'`,
  },
  {
    name: 'zone counters',
    sql: `INSERT INTO event_zone_counters (event_id, zone_id, capacity)
          SELECT e.id, z.id, z.capacity FROM seed_events e JOIN seed_zones z ON z.vn = e.vn
          WHERE e.st <> 'draft' AND z.kind = 'dancefloor'`,
  },
  {
    name: 'promos',
    sql: `INSERT INTO promo_codes (event_id, code, kind, value, usage_limit)
          SELECT e.id, p.code, p.kind, p.value, p.lim
          FROM seed_events e, (VALUES ('WELCOME10', 'percent', 10, 100000), ('MINUS100', 'fixed', 10000, 1000)) AS p (code, kind, value, lim)
          WHERE e.i IN (1, 2)`,
  },
  {
    name: 'controllers',
    sql: `INSERT INTO event_controllers (event_id, user_id)
          SELECT e.id, (SELECT id FROM users WHERE email = 'controller1@example.com') FROM seed_events e WHERE e.i IN (1, 4, 5, 6, 8, 9, 10)
          UNION ALL
          SELECT e.id, (SELECT id FROM users WHERE email = 'controller2@example.com') FROM seed_events e WHERE e.i BETWEEN 16 AND 25`,
  },
  {
    // number of sold tickets per event: E-BIG 3000, E-QUEUE 0, E-SOLDOUT 800 (all), E-CANCEL 10000 (one order per ticket)
    name: 'sold tickets',
    sql: `CREATE TEMP TABLE seed_sold AS
          SELECT e.id AS event_id, e.i AS ei, ss.id AS seat_id, ss.zone_id, ss.rn, gen_random_uuid() AS item_id,
                 CASE WHEN e.i = 4 THEN ss.rn ELSE (ss.rn - 1) / 4 END AS grp,
                 p.price_kop, GREATEST((p.price_kop * 5 + 50) / 100, 2000) AS fee_kop
          FROM (
            SELECT *, CASE WHEN i = 1 THEN 3000 WHEN i = 2 THEN 0 WHEN i = 3 THEN 800 WHEN i = 4 THEN 10000
                           WHEN st = 'draft' OR sales_start IS NOT NULL THEN 0
                           ELSE 4 * (100 + (i * 7919) % 61) END AS n
            FROM seed_events
          ) e
          JOIN seed_venues sv ON sv.n = e.vn
          JOIN seed_seats ss ON ss.venue_id = sv.id AND ss.rn <= e.n
          JOIN event_zone_prices p ON p.event_id = e.id AND p.zone_id = ss.zone_id`,
  },
  { name: 'sold idx', sql: `CREATE INDEX ON seed_sold (event_id, grp)` },
  {
    name: 'orders plan',
    sql: `CREATE TEMP TABLE seed_orders AS
          SELECT o.*, b.id AS user_id FROM (
            SELECT gen_random_uuid() AS id, s.event_id, s.ei, s.grp, sum(s.price_kop)::bigint AS subtotal, sum(s.fee_kop)::bigint AS fee,
                   CASE WHEN s.ei = 5 AND s.grp < 3 THEN 1
                        ELSE CASE WHEN x.b IN (2, 3) THEN 4 ELSE x.b END END AS bidx,
                   LEAST(now() - (1 + (s.ei * 31 + s.grp) % 80) * interval '1 day' - ((s.grp * 977) % 86400) * interval '1 second',
                         e.starts_at - interval '1 day') AS created
            FROM seed_sold s
            JOIN seed_events e ON e.id = s.event_id
            CROSS JOIN LATERAL (SELECT 1 + ((s.ei::bigint * 7919 + s.grp::bigint * 104729) % 50000)::int AS b) x
            GROUP BY s.event_id, s.ei, s.grp, e.starts_at, x.b
          ) o JOIN seed_buyers b ON b.idx = o.bidx`,
  },
  { name: 'orders idx', sql: `CREATE UNIQUE INDEX ON seed_orders (event_id, grp)` },
  {
    name: 'orders',
    sql: `INSERT INTO orders (id, user_id, event_id, status, expires_at, subtotal_kop, discount_kop, fee_kop, total_kop, paid_kop, paid_at, created_at)
          SELECT id, user_id, event_id, 'paid', created + interval '10 minutes', subtotal, 0, fee, subtotal + fee, subtotal + fee,
                 created + interval '2 minutes', created
          FROM seed_orders`,
  },
  {
    name: 'order items',
    sql: `INSERT INTO order_items (id, order_id, event_id, zone_id, seat_id, price_kop, discount_kop, fee_kop)
          SELECT s.item_id, o.id, s.event_id, s.zone_id, s.seat_id, s.price_kop, 0, s.fee_kop
          FROM seed_sold s JOIN seed_orders o ON o.event_id = s.event_id AND o.grp = s.grp`,
  },
  {
    name: 'tickets',
    sql: `INSERT INTO tickets (order_item_id, event_id, owner_id, zone_id, seat_id, status, used_at, used_gate, created_at)
          SELECT s.item_id, s.event_id, o.user_id, s.zone_id, s.seat_id,
                 CASE WHEN e.st = 'finished' AND s.rn % 10 <> 0 THEN 'used'::ticket_status ELSE 'valid'::ticket_status END,
                 CASE WHEN e.st = 'finished' AND s.rn % 10 <> 0 THEN e.starts_at + interval '10 minutes' END,
                 CASE WHEN e.st = 'finished' AND s.rn % 10 <> 0 THEN 'A' END,
                 o.created + interval '2 minutes'
          FROM seed_sold s JOIN seed_orders o ON o.event_id = s.event_id AND o.grp = s.grp
          JOIN seed_events e ON e.id = s.event_id`,
  },
  {
    name: 'seat holds',
    sql: `INSERT INTO seat_holds (event_id, seat_id, order_id, user_id, status, expires_at, created_at)
          SELECT s.event_id, s.seat_id, o.id, o.user_id, 'sold', o.created + interval '10 minutes', o.created
          FROM seed_sold s JOIN seed_orders o ON o.event_id = s.event_id AND o.grp = s.grp`,
  },
  {
    name: 'order history',
    sql: `INSERT INTO order_history (order_id, from_status, to_status, actor, note, created_at)
          SELECT id, NULL::order_status, 'holding'::order_status, 'seed', NULL::text, created FROM seed_orders
          UNION ALL
          SELECT id, 'holding'::order_status, 'paid'::order_status, 'seed', 'payment succeeded', created + interval '2 minutes' FROM seed_orders`,
  },
  {
    name: 'payments',
    sql: `INSERT INTO payments (order_id, provider_ref, amount_kop, status, created_at, updated_at)
          SELECT id, 'seed-' || id::text, subtotal + fee, 'succeeded', created + interval '1 minute', created + interval '2 minutes'
          FROM seed_orders`,
  },
  {
    // The payment stub is the "provider": seeded payments must exist there too, or refunds of seeded orders would 404.
    name: 'stub payments',
    sql: `INSERT INTO stub_payments (provider_ref, merchant_ref, amount_kop, status, created_at, updated_at)
          SELECT p.provider_ref, p.id::text, p.amount_kop, 'succeeded', p.created_at, p.updated_at
          FROM payments p WHERE p.provider_ref LIKE 'seed-%'`,
  },
  {
    name: 'ledger accounts',
    sql: `INSERT INTO ledger_accounts (code, organizer_id)
          SELECT 'provider_clearing', NULL::uuid UNION ALL SELECT 'service_fee_revenue', NULL::uuid
          UNION ALL SELECT 'ticket_revenue_liability', id FROM users WHERE role = 'organizer'
          ON CONFLICT (code, COALESCE(organizer_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO NOTHING`,
  },
  {
    name: 'ledger transactions',
    sql: `INSERT INTO ledger_transactions (operation_type, operation_ref, created_at)
          SELECT 'payment', id::text, created + interval '2 minutes' FROM seed_orders`,
  },
  {
    // same postings as the runtime (postPaymentLedger): clearing +total, liability -tickets, fee revenue -fee
    name: 'ledger entries',
    sql: `INSERT INTO ledger_entries (tx_id, account_id, amount_kop, created_at)
          SELECT lt.id, a.id, l.amount, lt.created_at
          FROM seed_orders o
          JOIN ledger_transactions lt ON lt.operation_type = 'payment' AND lt.operation_ref = o.id::text
          JOIN events ev ON ev.id = o.event_id
          CROSS JOIN LATERAL (VALUES ('provider_clearing', NULL::uuid, o.subtotal + o.fee),
                                     ('ticket_revenue_liability', ev.organizer_id, -o.subtotal),
                                     ('service_fee_revenue', NULL::uuid, -o.fee)) AS l (code, org, amount)
          JOIN ledger_accounts a ON a.code = l.code AND a.organizer_id IS NOT DISTINCT FROM l.org`,
  },
];

export async function seedBulk(databaseUrl: string, password: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [SEED_NAME]);
    const done = await client.query('SELECT 1 FROM seed_runs WHERE name = $1', [SEED_NAME]);
    if (done.rowCount) {
      console.log('seed: already seeded, skipping');
      return;
    }
    const hash = hashPassword(password);
    const started = Math.round(performance.now());
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL synchronous_commit = off');
      await client.query('SET LOCAL statement_timeout = 0');
      // The deferred balance trigger would run once per entry (3 M queries); it is replaced by one set-based
      // verification below, then re-enabled before commit.
      await client.query('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_balanced');
      await client.query('ALTER TABLE ledger_transactions DISABLE TRIGGER ledger_tx_nonempty');
      for (const step of STEPS) {
        const t = Math.round(performance.now());
        await client.query(step.sql, step.sql.includes('$1') ? [hash] : []);
        console.log(`seed: ${step.name} (${Math.round(performance.now()) - t} ms)`);
      }
      const bad = await client.query(
        `SELECT (SELECT count(*) FROM (SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING sum(amount_kop) <> 0) a)::int AS unbalanced,
                (SELECT count(*) FROM ledger_transactions lt WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.tx_id = lt.id))::int AS empty`,
      );
      const { unbalanced, empty } = bad.rows[0] as { unbalanced: number; empty: number };
      if (unbalanced !== 0 || empty !== 0)
        throw new Error(`seed ledger invalid: ${unbalanced} unbalanced, ${empty} empty`);
      await client.query('ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_balanced');
      await client.query('ALTER TABLE ledger_transactions ENABLE TRIGGER ledger_tx_nonempty');
      await client.query('INSERT INTO seed_runs (name) VALUES ($1)', [SEED_NAME]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    for (const table of [
      'users',
      'events',
      'seats',
      'orders',
      'order_items',
      'tickets',
      'seat_holds',
      'payments',
      'ledger_entries',
      'ledger_transactions',
    ]) {
      await client.query(`ANALYZE ${table}`);
    }
    console.log(`seed: done in ${Math.round((Math.round(performance.now()) - started) / 1000)} s`);
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', [SEED_NAME])
      .catch(() => undefined);
    await client.end();
  }
}
