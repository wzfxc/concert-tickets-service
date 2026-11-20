import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  dbErrorCode,
  holdSeats,
  type Db,
  type DbErrorCode,
  type PrismaClient,
} from '@tickets/db';

export function makeDb(max = 20): PrismaClient {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
  return createPrismaClient(url, max);
}

export interface Fixture {
  organizerId: string;
  venueId: string;
  zoneId: string;
  eventId: string;
  seatIds: bigint[];
}

export async function createUser(db: PrismaClient, role: 'buyer' | 'organizer' = 'buyer') {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `${id}@example.test`, passwordHash: 'x', name: 'T', role },
  });
  return id;
}

/** One organizer, venue, seated zone with `seats` seats, and an on-sale event. */
export async function createFixture(db: PrismaClient, seats: number, limit = 6): Promise<Fixture> {
  const organizerId = await createUser(db, 'organizer');
  const venue = await db.venue.create({ data: { organizerId, name: 'V', city: 'Kyiv' } });
  const zone = await db.zone.create({ data: { venueId: venue.id, name: 'Z' } });
  await db.seat.createMany({
    data: Array.from({ length: seats }, (_, i) => ({
      venueId: venue.id,
      zoneId: zone.id,
      rowLabel: 'A',
      seatNumber: i + 1,
    })),
  });
  const seatRows = await db.seat.findMany({
    where: { zoneId: zone.id },
    orderBy: { seatNumber: 'asc' },
  });
  const event = await db.event.create({
    data: {
      organizerId,
      venueId: venue.id,
      title: 'E',
      category: 'concert',
      city: 'Kyiv',
      startsAt: new Date('2099-01-01T18:00:00Z'),
      status: 'on_sale',
      perUserLimit: limit,
    },
  });
  return {
    organizerId,
    venueId: venue.id,
    zoneId: zone.id,
    eventId: event.id,
    seatIds: seatRows.map((s) => s.id),
  };
}

/** Order whose hold deadline is computed by the DB clock (`app_now()`), like production code must. */
export async function createOrder(db: Db, userId: string, eventId: string) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO orders (user_id, event_id, expires_at)
    VALUES (${userId}::uuid, ${eventId}::uuid, app_now() + interval '10 minutes') RETURNING id`;
  return rows[0]!.id;
}

/** Order + hold_seats in one transaction; returns null on success or the domain error code. */
export async function tryHold(
  db: PrismaClient,
  eventId: string,
  userId: string,
  seatIds: bigint[],
): Promise<DbErrorCode | 'UNEXPECTED' | null> {
  try {
    await db.$transaction(
      async (tx) => {
        const orderId = await createOrder(tx, userId, eventId);
        await holdSeats(tx, { eventId, userId, orderId, seatIds, ttlSeconds: 600 });
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
    return null;
  } catch (err) {
    return dbErrorCode(err) ?? 'UNEXPECTED';
  }
}
