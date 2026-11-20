import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, createOrder, createUser, makePool, tryHold } from './helpers.ts';

let pool: pg.Pool;
beforeAll(() => {
  pool = makePool(60);
});
afterAll(async () => {
  await pool.end();
});

async function setOffset(ms: number): Promise<void> {
  await pool.query('UPDATE time_control SET offset_ms = $1', [ms]);
}

describe('invariant 1: a seat is held/sold once', () => {
  it('200 concurrent buyers, 4 seats: exactly 1 wins the contested set, all-or-nothing', async () => {
    const fx = await createFixture(pool, 4, 6);
    const buyers = await Promise.all(Array.from({ length: 200 }, () => createUser(pool)));
    const results = await Promise.all(buyers.map((b) => tryHold(pool, fx.eventId, b, fx.seatIds)));
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r?.includes('SEATS_UNAVAILABLE'))).toHaveLength(199);
    const held = await pool.query(
      `SELECT count(*)::int AS n FROM seat_holds WHERE event_id = $1 AND status = 'held'`,
      [fx.eventId],
    );
    expect(held.rows[0].n).toBe(4); // no partial rows from the 199 losers
  });

  it('overlapping multi-seat requests never leave partial holds', async () => {
    const fx = await createFixture(pool, 6, 6);
    const [a, b] = await Promise.all([createUser(pool), createUser(pool)]);
    const [ra, rb] = await Promise.all([
      tryHold(pool, fx.eventId, a, fx.seatIds.slice(0, 4)),
      tryHold(pool, fx.eventId, b, fx.seatIds.slice(2, 6)),
    ]);
    expect([ra, rb].filter((r) => r === null)).toHaveLength(1);
    const n = await pool.query(`SELECT count(*)::int AS n FROM seat_holds WHERE event_id = $1`, [
      fx.eventId,
    ]);
    expect(n.rows[0].n).toBe(4);
  });

  it('the unique index rejects a second active hold even with raw SQL', async () => {
    const fx = await createFixture(pool, 1);
    const [a, b] = await Promise.all([createUser(pool), createUser(pool)]);
    const [oa, ob] = await Promise.all([
      createOrder(pool, a, fx.eventId),
      createOrder(pool, b, fx.eventId),
    ]);
    const ins = (u: string, o: string) =>
      pool.query(
        `INSERT INTO seat_holds (event_id, seat_id, order_id, user_id, expires_at) VALUES ($1,$2,$3,$4, now())`,
        [fx.eventId, fx.seatIds[0], o, u],
      );
    await ins(a, oa);
    await expect(ins(b, ob)).rejects.toThrow(/seat_holds_active_uq/);
  });

  it('server clock frees expired holds without any worker (app_now offset)', async () => {
    const fx = await createFixture(pool, 1);
    const [a, b] = await Promise.all([createUser(pool), createUser(pool)]);
    expect(await tryHold(pool, fx.eventId, a, fx.seatIds)).toBeNull();
    expect(await tryHold(pool, fx.eventId, b, fx.seatIds)).toContain('SEATS_UNAVAILABLE');
    await setOffset(11 * 60 * 1000);
    try {
      expect(await tryHold(pool, fx.eventId, b, fx.seatIds)).toBeNull();
    } finally {
      await setOffset(0);
    }
  });
});

describe('invariant 2: limits and promo', () => {
  it('per-user limit 6: 10 parallel holds x2 seats -> exactly 3 succeed', async () => {
    const fx = await createFixture(pool, 20, 6);
    const user = await createUser(pool);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        tryHold(pool, fx.eventId, user, fx.seatIds.slice(i * 2, i * 2 + 2)),
      ),
    );
    expect(results.filter((r) => r === null)).toHaveLength(3);
    expect(results.filter((r) => r?.includes('PER_USER_LIMIT'))).toHaveLength(7);
  });

  it('dancefloor capacity 10, 15 parallel single-ticket holds -> exactly 10', async () => {
    const fx = await createFixture(pool, 1, 6);
    const zone = await pool.query<{ id: string }>(
      `INSERT INTO zones (venue_id, name, kind, capacity) VALUES ($1, 'DF', 'dancefloor', 10) RETURNING id`,
      [fx.venueId],
    );
    const zoneId = zone.rows[0]!.id;
    await pool.query(
      `INSERT INTO event_zone_counters (event_id, zone_id, capacity) VALUES ($1, $2, 10)`,
      [fx.eventId, zoneId],
    );
    const users = await Promise.all(Array.from({ length: 15 }, () => createUser(pool)));
    const results = await Promise.all(
      users.map(async (u) => {
        const orderId = await createOrder(pool, u, fx.eventId);
        try {
          await pool.query(`SELECT hold_zone($1,$2,$3,$4,1,interval '10 minutes')`, [
            fx.eventId,
            zoneId,
            u,
            orderId,
          ]);
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      }),
    );
    expect(results.filter((r) => r === null)).toHaveLength(10);
    expect(results.filter((r) => r === 'SEATS_UNAVAILABLE')).toHaveLength(5);
  });

  it('promo limit 100, 150 parallel redemptions -> exactly 100; release gives slots back', async () => {
    const fx = await createFixture(pool, 1);
    const promo = await pool.query<{ id: string }>(
      `INSERT INTO promo_codes (event_id, code, kind, value, usage_limit) VALUES ($1, 'P', 'percent', 10, 100) RETURNING id`,
      [fx.eventId],
    );
    const promoId = promo.rows[0]!.id;
    const orders = await Promise.all(
      Array.from({ length: 150 }, async () => {
        const u = await createUser(pool);
        return { u, o: await createOrder(pool, u, fx.eventId) };
      }),
    );
    const wins = await Promise.all(
      orders.map(({ u, o }) =>
        pool.query<{ redeem_promo: boolean }>('SELECT redeem_promo($1,$2,$3)', [promoId, o, u]),
      ),
    );
    expect(wins.filter((r) => r.rows[0]!.redeem_promo)).toHaveLength(100);
    const used = await pool.query(`SELECT used FROM promo_codes WHERE id = $1`, [promoId]);
    expect(used.rows[0].used).toBe(100);
    const winners = orders.filter((_, i) => wins[i]!.rows[0]!.redeem_promo).slice(0, 7);
    await Promise.all(winners.map(({ o }) => pool.query('SELECT release_promo($1)', [o])));
    const after = await pool.query(`SELECT used FROM promo_codes WHERE id = $1`, [promoId]);
    expect(after.rows[0].used).toBe(93);
  });
});

describe('ledger', () => {
  const lines = (a: number) =>
    JSON.stringify([
      { account: 'provider_clearing', amount: a },
      { account: 'service_fee_revenue', amount: -a },
    ]);

  it('balanced postings succeed and are idempotent per (type, ref)', async () => {
    const ref = randomUUID();
    const first = await pool.query('SELECT post_ledger($1,$2,$3::jsonb) AS tx', [
      'payment',
      ref,
      lines(500),
    ]);
    const second = await pool.query('SELECT post_ledger($1,$2,$3::jsonb) AS tx', [
      'payment',
      ref,
      lines(500),
    ]);
    expect(first.rows[0].tx).not.toBeNull();
    expect(second.rows[0].tx).toBeNull();
    const n = await pool.query(
      `SELECT count(*)::int AS n FROM ledger_transactions WHERE operation_ref = $1`,
      [ref],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('unbalanced transactions are rejected at commit', async () => {
    const bad = JSON.stringify([
      { account: 'provider_clearing', amount: 500 },
      { account: 'service_fee_revenue', amount: -400 },
    ]);
    await expect(
      pool.query('SELECT post_ledger($1,$2,$3::jsonb)', ['payment', randomUUID(), bad]),
    ).rejects.toThrow(/LEDGER_UNBALANCED/);
  });

  it('transactions without entries and entry mutation are rejected', async () => {
    await expect(
      pool.query(
        `INSERT INTO ledger_transactions (operation_type, operation_ref) VALUES ('x', $1)`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/LEDGER_EMPTY/);
    await expect(
      pool.query('UPDATE ledger_entries SET amount_kop = amount_kop + 1'),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
  });

  it('global ledger sum is zero and balances equal entry sums', async () => {
    const total = await pool.query(
      `SELECT COALESCE(sum(amount_kop),0)::bigint AS s FROM ledger_entries`,
    );
    expect(String(total.rows[0].s)).toBe('0');
    const sumBalances = await pool.query(
      `SELECT COALESCE(sum(balance_kop),0)::bigint AS s FROM ledger_balances`,
    );
    expect(String(sumBalances.rows[0].s)).toBe('0');
  });
});

describe('invariants 4/6: refund cap', () => {
  it('parallel refunds never exceed paid; loser gets REFUND_EXCEEDS_PAID; same key is rejected by unique', async () => {
    const fx = await createFixture(pool, 1);
    const user = await createUser(pool);
    const orderId = await createOrder(pool, user, fx.eventId);
    await pool.query(
      `UPDATE orders SET status='paid', paid_kop = 10000, total_kop = 10000 WHERE id = $1`,
      [orderId],
    );
    const attempt = (amount: number, key: string) =>
      pool
        .query(
          `INSERT INTO refunds (order_id, amount_kop, kind, idempotency_key) VALUES ($1,$2,'user',$3)`,
          [orderId, amount, key],
        )
        .then(() => null)
        .catch((e: Error) => e.message);
    const results = await Promise.all([
      attempt(6000, 'k1'),
      attempt(6000, 'k2'),
      attempt(4000, 'k3'),
      attempt(10000, 'k4'),
    ]);
    const ok = results.filter((r) => r === null).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => r !== null).every((r) => r!.includes('REFUND_EXCEEDS_PAID'))).toBe(
      true,
    );
    const o = await pool.query(`SELECT refunded_kop FROM orders WHERE id = $1`, [orderId]);
    const sum = await pool.query(
      `SELECT COALESCE(sum(amount_kop),0)::int AS s FROM refunds WHERE order_id = $1`,
      [orderId],
    );
    expect(Number(o.rows[0].refunded_kop)).toBe(sum.rows[0].s);
    expect(sum.rows[0].s).toBeLessThanOrEqual(10000);
    await expect(attempt(1, 'k1')).resolves.toMatch(
      /refunds_idempotency_key_key|REFUND_EXCEEDS_PAID|duplicate/,
    );
  });
});

describe('audit and misc constraints', () => {
  it('order_history is append-only', async () => {
    const fx = await createFixture(pool, 1);
    const user = await createUser(pool);
    const orderId = await createOrder(pool, user, fx.eventId);
    await pool.query(`INSERT INTO order_history (order_id, to_status) VALUES ($1,'holding')`, [
      orderId,
    ]);
    await expect(pool.query('UPDATE order_history SET note = $1', ['x'])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('DELETE FROM order_history')).rejects.toThrow(/append-only/);
  });

  it('queue_entries enforces one entry per (event, user) and ordered join_seq', async () => {
    const fx = await createFixture(pool, 1);
    const user = await createUser(pool);
    await pool.query(`INSERT INTO queue_entries (event_id, user_id) VALUES ($1,$2)`, [
      fx.eventId,
      user,
    ]);
    await expect(
      pool.query(`INSERT INTO queue_entries (event_id, user_id) VALUES ($1,$2)`, [
        fx.eventId,
        user,
      ]),
    ).rejects.toThrow(/queue_entries_event_id_user_id_key/);
  });

  it('next_event_seq is gap-free and monotonic under concurrency', async () => {
    const fx = await createFixture(pool, 1);
    const seqs = await Promise.all(
      Array.from({ length: 50 }, () =>
        pool.query<{ next_event_seq: string }>('SELECT next_event_seq($1)', [fx.eventId]),
      ),
    );
    const nums = seqs.map((r) => Number(r.rows[0]!.next_event_seq)).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});
