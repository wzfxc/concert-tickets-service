import { randomUUID } from 'node:crypto';
import pg from 'pg';

export function makePool(max = 20): pg.Pool {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
  return new pg.Pool({ connectionString: url, max });
}

export interface Fixture {
  organizerId: string;
  venueId: string;
  zoneId: string;
  eventId: string;
  seatIds: number[];
}

export async function createUser(pool: pg.Pool, role = 'buyer'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, 'x', 'T', $3)`,
    [id, `${id}@example.test`, role],
  );
  return id;
}

/** One organizer, venue, seated zone with `seats` seats, and an on-sale event. */
export async function createFixture(pool: pg.Pool, seats: number, limit = 6): Promise<Fixture> {
  const organizerId = await createUser(pool, 'organizer');
  const venue = await pool.query<{ id: string }>(
    `INSERT INTO venues (organizer_id, name, city) VALUES ($1, 'V', 'Kyiv') RETURNING id`,
    [organizerId],
  );
  const venueId = venue.rows[0]!.id;
  const zone = await pool.query<{ id: string }>(
    `INSERT INTO zones (venue_id, name) VALUES ($1, 'Z') RETURNING id`,
    [venueId],
  );
  const zoneId = zone.rows[0]!.id;
  const seatRows = await pool.query<{ id: string }>(
    `INSERT INTO seats (venue_id, zone_id, row_label, seat_number)
     SELECT $1, $2, 'A', g FROM generate_series(1, $3) g RETURNING id`,
    [venueId, zoneId, seats],
  );
  const event = await pool.query<{ id: string }>(
    `INSERT INTO events (organizer_id, venue_id, title, category, city, starts_at, status, per_user_limit)
     VALUES ($1, $2, 'E', 'concert', 'Kyiv', now() + interval '30 days', 'on_sale', $3) RETURNING id`,
    [organizerId, venueId, limit],
  );
  return {
    organizerId,
    venueId,
    zoneId,
    eventId: event.rows[0]!.id,
    seatIds: seatRows.rows.map((r) => Number(r.id)),
  };
}

export async function createOrder(pool: pg.Pool, userId: string, eventId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO orders (user_id, event_id, expires_at) VALUES ($1, $2, app_now() + interval '10 minutes') RETURNING id`,
    [userId, eventId],
  );
  return r.rows[0]!.id;
}

/** Run hold_seats in its own transaction; returns null on success or the error message (= code). */
export async function tryHold(
  pool: pg.Pool,
  eventId: string,
  userId: string,
  seatIds: number[],
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderId = (
      await client.query<{ id: string }>(
        `INSERT INTO orders (user_id, event_id, expires_at) VALUES ($1, $2, app_now() + interval '10 minutes') RETURNING id`,
        [userId, eventId],
      )
    ).rows[0]!.id;
    await client.query(`SELECT hold_seats($1, $2, $3, $4::bigint[], interval '10 minutes')`, [
      eventId,
      userId,
      orderId,
      seatIds,
    ]);
    await client.query('COMMIT');
    return null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    return err instanceof Error ? err.message : String(err);
  } finally {
    client.release();
  }
}
