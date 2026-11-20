import { releasePromo, type Db, type PrismaClient } from '@tickets/db';
import { QUEUE_ADMIT_TTL_MS, WAITLIST_OFFER_TTL_MS } from '@tickets/shared';
import {
  addHistory,
  dbNow,
  queueEmail,
  recordSeatChanges,
  refreshSoldOut,
  type SeatChange,
} from './common.js';

export type ChangesByEvent = Map<string, SeatChange[]>;

export function pushChanges(into: ChangesByEvent, eventId: string, changes: SeatChange[]): void {
  if (!changes.length) return;
  into.set(eventId, [...(into.get(eventId) ?? []), ...changes]);
}

export interface QueueNotice {
  userId: string;
  eventId: string;
}

// ───────────────────────── virtual queue (Postgres is the truth) ─────────────────────────

/**
 * Admits waiting users in `joined_seq` order while fewer than `maxSelectors` hold a slot. Serialised per
 * event by an advisory lock, so two api instances (or workers) can never exceed the limit (invariant 10).
 * Returns the users admitted by this call. Must run inside a transaction.
 */
export async function admitNext(db: Db, eventId: string, maxSelectors: number): Promise<string[]> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'queue:' + eventId}, 0))`;
  const now = await dbNow(db);
  const ev = await db.$queryRaw<{ sales_start: Date | null; status: string }[]>`
    SELECT sales_start, status::text AS status FROM events WHERE id = ${eventId}::uuid`;
  const e = ev[0];
  if (!e || (e.sales_start && e.sales_start > now)) return [];
  if (e.status === 'cancelled' || e.status === 'draft') return [];
  // Admitted users that never started selecting within the window lose the slot (server clock).
  await db.$executeRaw`
    UPDATE queue_entries SET status = 'expired'
    WHERE event_id = ${eventId}::uuid AND status = 'admitted' AND admit_expires_at IS NOT NULL
      AND admit_expires_at <= ${now}`;
  const active = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM queue_entries WHERE event_id = ${eventId}::uuid AND status = 'admitted'`;
  const free = maxSelectors - active[0]!.n;
  if (free <= 0) return [];
  const admitted = await db.$queryRaw<{ user_id: string }[]>`
    UPDATE queue_entries SET status = 'admitted', admitted_at = ${now},
      admit_expires_at = ${new Date(now.getTime() + QUEUE_ADMIT_TTL_MS)}
    WHERE id IN (
      SELECT id FROM queue_entries WHERE event_id = ${eventId}::uuid AND status = 'waiting'
      ORDER BY joined_seq LIMIT ${free} FOR UPDATE SKIP LOCKED)
    RETURNING user_id`;
  return admitted.map((r) => r.user_id);
}

/** Frees the user's selector slot once none of their orders for the event is still being worked on. */
export async function finishQueueSlot(db: Db, userId: string, eventId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE queue_entries SET status = 'done'
    WHERE event_id = ${eventId}::uuid AND user_id = ${userId}::uuid AND status = 'admitted'
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = ${userId}::uuid AND o.event_id = ${eventId}::uuid
                      AND o.status IN ('holding', 'awaiting_payment') AND o.expires_at > app_now())`;
}

// ───────────────────────── waitlist ─────────────────────────

interface Waiter {
  id: string;
  user_id: string;
  zone_id: string | null;
  qty: number;
}

/**
 * One offer at a time (per freed seat set), valid 30 min; a lapsed offer sends its entry to `left` and the
 * next entry in FIFO order gets the seat. Seats under offer are unsellable to others (hold_seats checks).
 * Must run inside a transaction. Returns seat changes + offered users to notify.
 */
export async function processWaitlist(
  db: Db,
  eventId: string,
): Promise<{ changes: SeatChange[]; offered: { userId: string; expiresAt: Date }[] }> {
  const now = await dbNow(db);
  const changes: SeatChange[] = [];
  const offered: { userId: string; expiresAt: Date }[] = [];
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'waitlist:' + eventId}, 0))`;

  const lapsed = await db.$queryRaw<
    { id: string; entry_id: string; seat_id: number | null; zone_id: string | null }[]
  >`
    UPDATE waitlist_offers SET status = 'expired'
    WHERE event_id = ${eventId}::uuid AND status = 'offered' AND expires_at <= ${now}
    RETURNING id, entry_id, seat_id::float8 AS seat_id, zone_id`;
  if (lapsed.length) {
    await db.$executeRaw`
      UPDATE waitlist_entries SET status = 'left'
      WHERE id = ANY (${lapsed.map((l) => l.entry_id)}::uuid[]) AND status = 'offered'`;
    changes.push(
      ...(await recordSeatChanges(
        db,
        eventId,
        lapsed
          .filter((l) => l.seat_id !== null)
          .map((l) => ({ seatId: l.seat_id, zoneId: l.zone_id, state: 'free' as const })),
      )),
    );
  }

  for (;;) {
    const waiters = await db.$queryRaw<Waiter[]>`
      SELECT id, user_id, zone_id, qty FROM waitlist_entries
      WHERE event_id = ${eventId}::uuid AND status = 'waiting' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    const w = waiters[0];
    if (!w) break;
    const expiresAt = new Date(now.getTime() + WAITLIST_OFFER_TTL_MS);
    if (w.zone_id) {
      const cap = await db.$queryRaw<{ free: number }[]>`
        SELECT (c.capacity
          - COALESCE((SELECT sum(qty) FROM zone_holds h WHERE h.event_id = c.event_id AND h.zone_id = c.zone_id
                      AND h.status IN ('held', 'sold')), 0)
          - COALESCE((SELECT sum(w2.qty) FROM waitlist_offers o JOIN waitlist_entries w2 ON w2.id = o.entry_id
                      WHERE o.event_id = c.event_id AND o.zone_id = c.zone_id AND o.status = 'offered'
                        AND o.expires_at > ${now}), 0))::int AS free
        FROM event_zone_counters c WHERE c.event_id = ${eventId}::uuid AND c.zone_id = ${w.zone_id}::uuid`;
      if ((cap[0]?.free ?? 0) < w.qty) break;
      await db.$executeRaw`
        INSERT INTO waitlist_offers (entry_id, event_id, zone_id, expires_at)
        VALUES (${w.id}::uuid, ${eventId}::uuid, ${w.zone_id}::uuid, ${expiresAt})`;
    } else {
      const free = await db.$queryRaw<{ id: number }[]>`
        SELECT s.id::float8 AS id FROM seats s JOIN events e ON e.venue_id = s.venue_id
        WHERE e.id = ${eventId}::uuid
          AND (EXISTS (SELECT 1 FROM event_zone_prices p WHERE p.event_id = e.id AND p.zone_id = s.zone_id)
               OR EXISTS (SELECT 1 FROM event_seat_prices sp WHERE sp.event_id = e.id AND sp.seat_id = s.id))
          AND NOT EXISTS (SELECT 1 FROM event_blocked_seats b WHERE b.event_id = e.id AND b.seat_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM seat_holds h WHERE h.event_id = e.id AND h.seat_id = s.id
                          AND (h.status = 'sold' OR (h.status = 'held' AND h.expires_at > ${now})))
          AND NOT EXISTS (SELECT 1 FROM waitlist_offers o WHERE o.event_id = e.id AND o.seat_id = s.id
                          AND o.status = 'offered' AND o.expires_at > ${now})
        ORDER BY s.id LIMIT ${w.qty}`;
      if (free.length < w.qty) break;
      for (const seat of free) {
        await db.$executeRaw`
          INSERT INTO waitlist_offers (entry_id, event_id, seat_id, expires_at)
          VALUES (${w.id}::uuid, ${eventId}::uuid, ${seat.id}::bigint, ${expiresAt})`;
      }
      changes.push(
        ...(await recordSeatChanges(
          db,
          eventId,
          free.map((s) => ({ seatId: s.id, state: 'offered' as const })),
        )),
      );
    }
    await db.$executeRaw`UPDATE waitlist_entries SET status = 'offered' WHERE id = ${w.id}::uuid`;
    const user = await db.$queryRaw<
      { email: string }[]
    >`SELECT email FROM users WHERE id = ${w.user_id}::uuid`;
    if (user[0]) {
      await queueEmail(
        db,
        `waitlist-offer:${w.id}:${expiresAt.toISOString()}`,
        user[0].email,
        'A seat is available for you',
        `A seat you were waiting for is reserved for you until ${expiresAt.toISOString()}.`,
      );
    }
    offered.push({ userId: w.user_id, expiresAt });
  }
  return { changes, offered };
}

// ───────────────────────── order expiry / release ─────────────────────────

/**
 * Ends an unpaid order: holds are released, promo slot returned, queue slot freed, seats announced as free.
 * Idempotent (no-op unless the order is still holding/awaiting_payment). Runs inside the caller's tx.
 */
export async function releaseOrder(
  db: Db,
  orderId: string,
  actor: string,
  note: string,
  sink: ChangesByEvent,
  touched: Set<string>,
): Promise<boolean> {
  const rows = await db.$queryRaw<{ user_id: string; event_id: string; prev: string }[]>`
    UPDATE orders o SET status = 'expired'
    FROM (SELECT id, status FROM orders WHERE id = ${orderId}::uuid FOR UPDATE) old
    WHERE o.id = old.id AND o.status IN ('holding', 'awaiting_payment')
    RETURNING o.user_id, o.event_id, old.status::text AS prev`;
  const o = rows[0];
  if (!o) return false;
  const seats = await db.$queryRaw<{ seat_id: number }[]>`
    UPDATE seat_holds SET status = 'released' WHERE order_id = ${orderId}::uuid AND status = 'held'
    RETURNING seat_id::float8 AS seat_id`;
  await db.$executeRaw`UPDATE zone_holds SET status = 'released' WHERE order_id = ${orderId}::uuid AND status = 'held'`;
  await releasePromo(db, orderId);
  await addHistory(db, orderId, o.prev, 'expired', actor, note);
  await finishQueueSlot(db, o.user_id, o.event_id);
  const zoneRows = await db.$queryRaw<{ zone_id: string }[]>`
    SELECT DISTINCT zone_id FROM zone_holds WHERE order_id = ${orderId}::uuid AND status = 'released'`;
  pushChanges(
    sink,
    o.event_id,
    await recordSeatChanges(db, o.event_id, [
      ...seats.map((s) => ({ seatId: s.seat_id, state: 'free' as const })),
      ...zoneRows.map((z) => ({ zoneId: z.zone_id, state: 'free' as const })),
    ]),
  );
  touched.add(o.event_id);
  return true;
}

/** After seats were freed: offer them to the waitlist and recompute `sold_out`. */
export async function afterSeatsFreed(
  db: Db,
  eventId: string,
  sink: ChangesByEvent,
): Promise<void> {
  const { changes } = await processWaitlist(db, eventId);
  pushChanges(sink, eventId, changes);
  await refreshSoldOut(db, eventId);
}

export interface SweepResult {
  changes: ChangesByEvent;
  events: Set<string>;
  expiredOrders: number;
}

/**
 * Everything time-driven that the DB can derive on its own (invariant 3/9): lapsed holds/orders,
 * waitlist offers, queue admission windows. The worker runs this on a loop; correctness never depends on it
 * because hold_seats()/hold_zone() and the queue gate also evaluate expiry with the server clock.
 */
export async function sweepOnce(
  prisma: PrismaClient,
  maxSelectors: number,
  batch = 200,
): Promise<SweepResult> {
  const result: SweepResult = { changes: new Map(), events: new Set(), expiredOrders: 0 };
  const touched = new Set<string>();
  await prisma.$transaction(
    async (tx) => {
      const due = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE status IN ('holding', 'awaiting_payment') AND expires_at <= app_now()
        ORDER BY expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
      for (const o of due) {
        if (await releaseOrder(tx, o.id, 'system', 'hold expired', result.changes, touched))
          result.expiredOrders++;
      }
      // Offers whose time ran out, even when no order expired.
      const lapsed = await tx.$queryRaw<{ event_id: string }[]>`
        SELECT DISTINCT event_id FROM waitlist_offers WHERE status = 'offered' AND expires_at <= app_now()`;
      for (const l of lapsed) touched.add(l.event_id);
      for (const eventId of touched) await afterSeatsFreed(tx, eventId, result.changes);
    },
    { maxWait: 30_000, timeout: 60_000 },
  );
  // Queue windows: expire stale admissions and admit the next users for events with waiting entries.
  const queues = await prisma.$queryRaw<{ event_id: string }[]>`
    SELECT DISTINCT event_id FROM queue_entries WHERE status IN ('waiting', 'admitted')`;
  for (const q of queues) {
    await prisma.$transaction((tx) => admitNext(tx, q.event_id, maxSelectors));
    result.events.add(q.event_id);
  }
  for (const id of touched) result.events.add(id);
  return result;
}
