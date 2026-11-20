import { postLedger, type Db } from '@tickets/db';
import { quoteTickets } from '@tickets/shared';

export type SeatState = 'free' | 'held' | 'sold' | 'offered';

export interface SeatChange {
  seq: number;
  seatId: number | null;
  zoneId: string | null;
  state: SeatState;
}

export interface OrderRow {
  id: string;
  user_id: string;
  event_id: string;
  status: string;
  expires_at: Date;
  promo_id: string | null;
  subtotal_kop: number;
  discount_kop: number;
  fee_kop: number;
  total_kop: number;
  paid_kop: number;
  refunded_kop: number;
  paid_at: Date | null;
}

const ORDER_COLUMNS = `id, user_id, event_id, status::text AS status, expires_at, promo_id,
  subtotal_kop::float8 AS subtotal_kop, discount_kop::float8 AS discount_kop, fee_kop::float8 AS fee_kop,
  total_kop::float8 AS total_kop, paid_kop::float8 AS paid_kop, refunded_kop::float8 AS refunded_kop, paid_at`;

export async function dbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT app_now() AS now`;
  return rows[0]!.now;
}

/** Locks the order row (serialises every money/state change per order across api instances and workers). */
export async function lockOrder(db: Db, orderId: string): Promise<OrderRow | null> {
  const rows = await db.$queryRawUnsafe<OrderRow[]>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1::uuid FOR UPDATE`,
    orderId,
  );
  return rows[0] ?? null;
}

export async function getOrder(db: Db, orderId: string): Promise<OrderRow | null> {
  const rows = await db.$queryRawUnsafe<OrderRow[]>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1::uuid`,
    orderId,
  );
  return rows[0] ?? null;
}

/**
 * Appends one row per change to `seat_events` with a gap-free per-event `seq` (live map + resync).
 * Call near the end of the transaction: it takes the per-event sequence row lock until commit.
 */
export async function recordSeatChanges(
  db: Db,
  eventId: string,
  items: { seatId?: number | null; zoneId?: string | null; state: SeatState }[],
): Promise<SeatChange[]> {
  const out: SeatChange[] = [];
  for (const it of items) {
    const rows = await db.$queryRaw<{ seq: number }[]>`
      INSERT INTO seat_events (event_id, seq, seat_id, zone_id, state)
      VALUES (${eventId}::uuid, next_event_seq(${eventId}::uuid), ${it.seatId ?? null}::bigint,
              ${it.zoneId ?? null}::uuid, ${it.state})
      RETURNING seq::float8 AS seq`;
    out.push({
      seq: rows[0]!.seq,
      seatId: it.seatId ?? null,
      zoneId: it.zoneId ?? null,
      state: it.state,
    });
  }
  return out;
}

export async function addHistory(
  db: Db,
  orderId: string,
  from: string | null,
  to: string,
  actor: string,
  note: string,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO order_history (order_id, from_status, to_status, actor, note)
    VALUES (${orderId}::uuid, ${from}::order_status, ${to}::order_status, ${actor}, ${note})`;
}

/** Re-prices an order (promo discount distribution, service fee per ticket) after any change. */
export async function recomputeOrder(db: Db, orderId: string): Promise<void> {
  const items = await db.$queryRaw<{ id: string; price_kop: number }[]>`
    SELECT id, price_kop::float8 AS price_kop FROM order_items WHERE order_id = ${orderId}::uuid ORDER BY id`;
  const promos = await db.$queryRaw<{ kind: 'percent' | 'fixed'; value: number }[]>`
    SELECT p.kind, p.value::float8 AS value FROM orders o JOIN promo_codes p ON p.id = o.promo_id
    WHERE o.id = ${orderId}::uuid`;
  const quotes = quoteTickets(
    items.map((i) => i.price_kop),
    promos[0] ?? null,
  );
  let subtotal = 0;
  let discount = 0;
  let fee = 0;
  for (const [i, item] of items.entries()) {
    const q = quotes[i]!;
    subtotal += q.priceKop;
    discount += q.discountKop;
    fee += q.feeKop;
    await db.$executeRaw`
      UPDATE order_items SET discount_kop = ${q.discountKop}::bigint, fee_kop = ${q.feeKop}::bigint
      WHERE id = ${item.id}::uuid`;
  }
  await db.$executeRaw`
    UPDATE orders SET subtotal_kop = ${subtotal}::bigint, discount_kop = ${discount}::bigint,
      fee_kop = ${fee}::bigint, total_kop = ${subtotal - discount + fee}::bigint
    WHERE id = ${orderId}::uuid`;
}

const seatTotals = new Map<string, number>();

/** Sellable capacity of an event (seated seats + dancefloor capacity - blocked). Venue layout is immutable. */
async function capacityOf(db: Db, eventId: string): Promise<number> {
  const cached = seatTotals.get(eventId);
  if (cached !== undefined) return cached;
  const rows = await db.$queryRaw<{ total: number }[]>`
    SELECT ((SELECT count(*) FROM seats s JOIN events e ON e.venue_id = s.venue_id WHERE e.id = ${eventId}::uuid)
      + (SELECT COALESCE(sum(capacity), 0) FROM event_zone_counters WHERE event_id = ${eventId}::uuid))::float8 AS total`;
  const total = rows[0]!.total;
  seatTotals.set(eventId, total);
  return total;
}

/** Keeps `sold_out` in step with availability (set when nothing is left, cleared when something frees up). */
export async function refreshSoldOut(db: Db, eventId: string): Promise<'sold_out' | 'open' | null> {
  const total = await capacityOf(db, eventId);
  const rows = await db.$queryRaw<{ taken: number }[]>`
    SELECT ((SELECT count(*) FROM seat_holds WHERE event_id = ${eventId}::uuid AND status IN ('held', 'sold'))
      + (SELECT COALESCE(sum(qty), 0) FROM zone_holds WHERE event_id = ${eventId}::uuid AND status IN ('held', 'sold'))
      + (SELECT count(*) FROM event_blocked_seats WHERE event_id = ${eventId}::uuid))::float8 AS taken`;
  const full = rows[0]!.taken >= total;
  if (full) {
    const n = await db.$executeRaw`
      UPDATE events SET status = 'sold_out' WHERE id = ${eventId}::uuid AND status IN ('on_sale', 'rescheduled')`;
    return n > 0 ? 'sold_out' : null;
  }
  const n = await db.$executeRaw`
    UPDATE events SET status = CASE WHEN rescheduled_at IS NULL THEN 'on_sale'::event_status ELSE 'rescheduled'::event_status END
    WHERE id = ${eventId}::uuid AND status = 'sold_out'`;
  return n > 0 ? 'open' : null;
}

/** Double-entry posting for a successful payment: provider cash in, ticket revenue + service fee out. */
export async function postPaymentLedger(
  db: Db,
  order: OrderRow,
  organizerId: string,
): Promise<void> {
  const ticketsNet = order.subtotal_kop - order.discount_kop;
  const lines = [
    { account: 'provider_clearing', amount: order.total_kop },
    { account: 'ticket_revenue_liability', organizer: organizerId, amount: -ticketsNet },
    ...(order.fee_kop > 0 ? [{ account: 'service_fee_revenue', amount: -order.fee_kop }] : []),
  ].filter((l) => l.amount !== 0);
  await postLedger(db, 'payment', order.id, lines);
}

/** Refund posting: cash back to the buyer; ticket part hits `refunds` (organizer), fee part reverses fee revenue. */
export async function postRefundLedger(
  db: Db,
  refund: { id: string; amount_kop: number; fee_kop: number },
  organizerId: string,
): Promise<void> {
  const ticketPart = refund.amount_kop - refund.fee_kop;
  const lines = [
    { account: 'provider_clearing', amount: -refund.amount_kop },
    ...(ticketPart > 0 ? [{ account: 'refunds', organizer: organizerId, amount: ticketPart }] : []),
    ...(refund.fee_kop > 0 ? [{ account: 'service_fee_revenue', amount: refund.fee_kop }] : []),
  ];
  await postLedger(db, 'refund', refund.id, lines);
}

export function queueEmail(
  db: Db,
  dedupKey: string,
  toEmail: string,
  subject: string,
  body: string,
): Promise<number> {
  return db.$executeRaw`
    INSERT INTO email_outbox (dedup_key, to_email, subject, body)
    VALUES (${dedupKey}, ${toEmail}, ${subject}, ${body}) ON CONFLICT (dedup_key) DO NOTHING`;
}
