/**
 * Raw SQL, used ONLY where Prisma cannot express the invariant: row/advisory locks, atomic
 * multi-row checks, partial-unique-backed inserts and the deferred ledger-balance trigger.
 * The logic lives in Postgres functions (see prisma/migrations); these are typed call wrappers.
 * All of them accept a `PrismaClient` or an interactive-transaction client, so callers decide
 * the transaction boundary (the deferred ledger trigger fires at COMMIT).
 *
 * Domain errors raised by the functions arrive as Postgres exceptions whose message is the code
 * (`SEATS_UNAVAILABLE`, `PER_USER_LIMIT`, ...); use {@link dbErrorCode} to read it.
 */
import type { Prisma, PrismaClient } from './generated/client.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export const DB_ERROR_CODES = [
  'SEATS_UNAVAILABLE',
  'PER_USER_LIMIT',
  'SEAT_OFFERED',
  'EVENT_NOT_FOUND',
  'ZONE_NOT_FOUND',
  'REFUND_EXCEEDS_PAID',
  'LEDGER_UNBALANCED',
  'LEDGER_EMPTY',
] as const;
export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

/** Extracts the domain error code from an error thrown by a raw-SQL invariant, if any. */
export function dbErrorCode(err: unknown): DbErrorCode | null {
  const text = err instanceof Error ? `${err.message} ${String(err.cause ?? '')}` : String(err);
  return DB_ERROR_CODES.find((c) => text.includes(c)) ?? null;
}

export interface LedgerLine {
  account: string;
  organizer?: string | null;
  amount: number;
}

/** All-or-nothing seat hold (advisory lock per user+event, partial unique index per seat). Returns expiry. */
export async function holdSeats(
  db: Db,
  p: { eventId: string; userId: string; orderId: string; seatIds: bigint[]; ttlSeconds: number },
): Promise<Date> {
  const rows = await db.$queryRaw<{ expires: Date }[]>`
    SELECT hold_seats(${p.eventId}::uuid, ${p.userId}::uuid, ${p.orderId}::uuid,
                      ${p.seatIds}::bigint[], make_interval(secs => ${p.ttlSeconds})) AS expires`;
  return rows[0]!.expires;
}

/** Dancefloor capacity hold, serialised on the zone counter row (`FOR UPDATE`). Returns expiry. */
export async function holdZone(
  db: Db,
  p: {
    eventId: string;
    zoneId: string;
    userId: string;
    orderId: string;
    qty: number;
    ttlSeconds: number;
  },
): Promise<Date> {
  const rows = await db.$queryRaw<{ expires: Date }[]>`
    SELECT hold_zone(${p.eventId}::uuid, ${p.zoneId}::uuid, ${p.userId}::uuid, ${p.orderId}::uuid,
                     ${p.qty}::int, make_interval(secs => ${p.ttlSeconds})) AS expires`;
  return rows[0]!.expires;
}

/** Atomically consumes one promo slot; false when exhausted/expired. */
export async function redeemPromo(
  db: Db,
  promoId: string,
  orderId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<{ ok: boolean }[]>`
    SELECT redeem_promo(${promoId}::uuid, ${orderId}::uuid, ${userId}::uuid) AS ok`;
  return rows[0]!.ok;
}

export async function releasePromo(db: Db, orderId: string): Promise<void> {
  await db.$executeRaw`SELECT release_promo(${orderId}::uuid)`;
}

/**
 * Idempotent double-entry posting. Returns the transaction id, or null if (type, ref) was already
 * posted. Lines must sum to zero; the check runs in a deferred trigger at COMMIT.
 */
export async function postLedger(
  db: Db,
  type: string,
  ref: string,
  lines: LedgerLine[],
): Promise<bigint | null> {
  const rows = await db.$queryRaw<{ tx: bigint | null }[]>`
    SELECT post_ledger(${type}, ${ref}, ${JSON.stringify(lines)}::jsonb) AS tx`;
  return rows[0]!.tx;
}

/** Next gap-free per-event sequence number for the live seat map. */
export async function nextEventSeq(db: Db, eventId: string): Promise<bigint> {
  const rows = await db.$queryRaw<
    { seq: bigint }[]
  >`SELECT next_event_seq(${eventId}::uuid) AS seq`;
  return rows[0]!.seq;
}

/** Test/ops hook: shifts the DB clock used by `app_now()`. */
export async function setTimeOffset(db: Db, ms: number): Promise<void> {
  await db.$executeRaw`UPDATE time_control SET offset_ms = ${ms}`;
}
