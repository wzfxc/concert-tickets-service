import { holdSeats, holdZone, dbErrorCode, type Db, type PrismaClient } from '@tickets/db';
import { HOLD_TTL_MS } from '@tickets/shared';
import { AppError } from '../errors.js';
import {
  addHistory,
  dbNow,
  getOrder,
  lockOrder,
  postPaymentLedger,
  postRefundLedger,
  queueEmail,
  recordSeatChanges,
  type OrderRow,
} from './common.js';
import {
  afterSeatsFreed,
  finishQueueSlot,
  pushChanges,
  releaseOrder,
  type ChangesByEvent,
} from './lifecycle.js';
import type { StubClient } from './stubClient.js';

const TX = { maxWait: 30_000, timeout: 60_000 } as const;
const MAX_REFUND_ATTEMPTS = 8;

export interface PaymentOutcome {
  outcome: 'paid' | 'refunded_late' | 'failed' | 'duplicate' | 'ignored';
  eventId?: string;
  orderId?: string;
  userId?: string;
  refundId?: string;
  changes: ChangesByEvent;
}

const none = (outcome: PaymentOutcome['outcome']): PaymentOutcome => ({
  outcome,
  changes: new Map(),
});

/** First statement of every webhook transaction: a (providerRef, type) pair is processed at most once. */
async function claimWebhook(db: Db, providerRef: string, type: string): Promise<boolean> {
  const n = await db.$executeRaw`
    INSERT INTO payment_webhook_events (provider_ref, event_type) VALUES (${providerRef}, ${type})
    ON CONFLICT DO NOTHING`;
  return n === 1;
}

async function organizerOf(db: Db, eventId: string): Promise<string> {
  const rows = await db.$queryRaw<{ organizer_id: string }[]>`
    SELECT organizer_id FROM events WHERE id = ${eventId}::uuid`;
  return rows[0]!.organizer_id;
}

// ───────────────────────── payment creation ─────────────────────────

export interface StartedPayment {
  paymentId: string;
  providerRef: string;
  payUrl: string;
  amountKop: number;
}

export async function startPayment(
  prisma: PrismaClient,
  stub: StubClient,
  orderId: string,
  userId: string,
): Promise<StartedPayment> {
  const payment = await prisma.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order || order.user_id !== userId) throw new AppError('NOT_FOUND', 'Order not found');
    if (order.status !== 'holding' && order.status !== 'awaiting_payment') {
      throw new AppError('INVALID_STATE', `Order is ${order.status}`);
    }
    const now = await dbNow(tx);
    if (order.expires_at <= now)
      throw new AppError('HOLD_EXPIRED', 'The hold on these seats has expired');
    const ev = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM events WHERE id = ${order.event_id}::uuid`;
    if (ev[0]?.status === 'cancelled')
      throw new AppError('EVENT_CANCELLED', 'The event was cancelled');
    const existing = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM payments WHERE order_id = ${orderId}::uuid AND status = 'pending' ORDER BY created_at LIMIT 1`;
    if (existing[0]) return { id: existing[0].id, amount: order.total_kop };
    const created = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO payments (order_id, amount_kop) VALUES (${orderId}::uuid, ${order.total_kop}::bigint) RETURNING id`;
    if (order.status === 'holding') {
      await tx.$executeRaw`UPDATE orders SET status = 'awaiting_payment' WHERE id = ${orderId}::uuid`;
      await addHistory(
        tx,
        orderId,
        'holding',
        'awaiting_payment',
        `user:${userId}`,
        'payment started',
      );
    }
    return { id: created[0]!.id, amount: order.total_kop };
  }, TX);

  // The provider call is idempotent on merchantRef (= our payment id), so retries are safe.
  let last: { retryable: boolean; status: number } = { retryable: true, status: 0 };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 150 * 2 ** attempt));
    const res = await stub.createPayment({
      merchantRef: payment.id,
      amountKop: payment.amount,
      returnUrl: `/orders/${orderId}`,
    });
    if (res.ok) {
      await prisma.$executeRaw`
        UPDATE payments SET provider_ref = ${res.data.providerRef}, updated_at = now() WHERE id = ${payment.id}::uuid`;
      return {
        paymentId: payment.id,
        providerRef: res.data.providerRef,
        payUrl: res.data.payUrl,
        amountKop: payment.amount,
      };
    }
    last = res;
    if (!res.retryable) break;
  }
  throw new AppError('SERVICE_UNAVAILABLE', 'Payment provider is unavailable, try again', {
    providerStatus: last.status,
  });
}

// ───────────────────────── issuing tickets ─────────────────────────

async function finalizePaid(
  tx: Db,
  order: OrderRow,
  organizerId: string,
  note: string,
  sink: ChangesByEvent,
): Promise<void> {
  const seats = await tx.$queryRaw<{ seat_id: number }[]>`
    UPDATE seat_holds SET status = 'sold' WHERE order_id = ${order.id}::uuid AND status = 'held'
    RETURNING seat_id::float8 AS seat_id`;
  await tx.$executeRaw`UPDATE zone_holds SET status = 'sold' WHERE order_id = ${order.id}::uuid AND status = 'held'`;
  await tx.$executeRaw`
    INSERT INTO tickets (order_item_id, event_id, owner_id, zone_id, seat_id)
    SELECT id, event_id, ${order.user_id}::uuid, zone_id, seat_id FROM order_items WHERE order_id = ${order.id}::uuid
    ON CONFLICT (order_item_id) DO NOTHING`;
  await tx.$executeRaw`
    UPDATE orders SET status = 'paid', paid_kop = total_kop, paid_at = app_now() WHERE id = ${order.id}::uuid`;
  await addHistory(tx, order.id, order.status, 'paid', 'system', note);
  await addHistory(tx, order.id, 'paid', 'paid', 'system', 'tickets issued');
  await postPaymentLedger(tx, order, organizerId);
  if (seats.length) {
    await tx.$executeRaw`
      UPDATE waitlist_entries SET status = 'done' WHERE id IN (
        SELECT o.entry_id FROM waitlist_offers o JOIN waitlist_entries w ON w.id = o.entry_id
        WHERE o.event_id = ${order.event_id}::uuid AND o.status = 'offered' AND w.user_id = ${order.user_id}::uuid
          AND o.seat_id = ANY (${seats.map((s) => s.seat_id)}::bigint[]))`;
    await tx.$executeRaw`
      UPDATE waitlist_offers SET status = 'accepted'
      WHERE event_id = ${order.event_id}::uuid AND status = 'offered'
        AND seat_id = ANY (${seats.map((s) => s.seat_id)}::bigint[])
        AND entry_id IN (SELECT id FROM waitlist_entries WHERE user_id = ${order.user_id}::uuid)`;
  }
  await finishQueueSlot(tx, order.user_id, order.event_id);
  const zones = await tx.$queryRaw<{ zone_id: string }[]>`
    SELECT DISTINCT zone_id FROM zone_holds WHERE order_id = ${order.id}::uuid AND status = 'sold'`;
  pushChanges(
    sink,
    order.event_id,
    await recordSeatChanges(tx, order.event_id, [
      ...seats.map((s) => ({ seatId: s.seat_id, state: 'sold' as const })),
      ...zones.map((z) => ({ zoneId: z.zone_id, state: 'sold' as const })),
    ]),
  );
  const user = await tx.$queryRaw<
    { email: string }[]
  >`SELECT email FROM users WHERE id = ${order.user_id}::uuid`;
  if (user[0]) {
    await queueEmail(
      tx,
      `tickets:${order.id}`,
      user[0].email,
      'Your tickets',
      `Order ${order.id} is paid. Tickets (PDF with QR) are attached.`,
    );
  }
}

/** Re-acquires the seats of an expired order for a late payment; throws a domain code if they are gone. */
async function reholdOrder(tx: Db, order: OrderRow): Promise<void> {
  const items = await tx.$queryRaw<{ seat_id: number | null; zone_id: string }[]>`
    SELECT seat_id::float8 AS seat_id, zone_id FROM order_items WHERE order_id = ${order.id}::uuid`;
  const ttlSeconds = HOLD_TTL_MS / 1000;
  const seatIds = items.filter((i) => i.seat_id !== null).map((i) => BigInt(i.seat_id as number));
  if (seatIds.length) {
    await holdSeats(tx, {
      eventId: order.event_id,
      userId: order.user_id,
      orderId: order.id,
      seatIds,
      ttlSeconds,
    });
  }
  const perZone = new Map<string, number>();
  for (const i of items.filter((x) => x.seat_id === null))
    perZone.set(i.zone_id, (perZone.get(i.zone_id) ?? 0) + 1);
  for (const [zoneId, qty] of perZone) {
    await holdZone(tx, {
      eventId: order.event_id,
      zoneId,
      userId: order.user_id,
      orderId: order.id,
      qty,
      ttlSeconds,
    });
  }
  if (order.promo_id) {
    // The promo slot was returned on expiry; take it again or treat the order as unfulfillable.
    const n = await tx.$executeRaw`
      UPDATE promo_codes SET used = used + 1 WHERE id = ${order.promo_id}::uuid AND used < usage_limit`;
    if (n === 0) throw new AppError('PROMO_EXHAUSTED', 'Promo code no longer available');
    await tx.$executeRaw`
      UPDATE promo_usages SET released_at = NULL WHERE order_id = ${order.id}::uuid AND released_at IS NOT NULL`;
  }
}

// ───────────────────────── webhooks: payment ─────────────────────────

/**
 * Payment confirmed by the provider (webhook or reconciliation). Rules (spec "Оплата после удержания"):
 * seats still ours / free again → tickets are issued; seats taken (or event cancelled) → full automatic
 * refund including the service fee. Exactly-once per (providerRef, type) and per payment status.
 */
export async function onPaymentSucceeded(
  prisma: PrismaClient,
  providerRef: string,
): Promise<PaymentOutcome> {
  const refundable = new Set([
    'SEATS_UNAVAILABLE',
    'PER_USER_LIMIT',
    'SEAT_OFFERED',
    'PROMO_EXHAUSTED',
    'EVENT_CANCELLED',
  ]);
  try {
    return await prisma.$transaction(async (tx) => {
      const sink: ChangesByEvent = new Map();
      if (!(await claimWebhook(tx, providerRef, 'payment.succeeded'))) return none('duplicate');
      const pay = await tx.$queryRaw<{ id: string; order_id: string; status: string }[]>`
        SELECT id, order_id, status::text AS status FROM payments WHERE provider_ref = ${providerRef} FOR UPDATE`;
      const p = pay[0];
      if (!p) throw new AppError('NOT_FOUND', 'Unknown payment');
      if (p.status === 'succeeded') return none('duplicate');
      const order = (await lockOrder(tx, p.order_id))!;
      if (['paid', 'partially_refunded', 'refunded'].includes(order.status)) {
        // A second payment for an already-paid order: surfaced to finance, never silently posted.
        await tx.$executeRaw`UPDATE payments SET status = 'succeeded', updated_at = now() WHERE id = ${p.id}::uuid`;
        await tx.$executeRaw`
          INSERT INTO failed_jobs (queue, job_key, payload, error)
          VALUES ('payments', ${'duplicate-payment:' + providerRef}, ${JSON.stringify({ orderId: order.id })}::jsonb,
                  'second successful payment for an already paid order') ON CONFLICT DO NOTHING`;
        return none('ignored');
      }
      const ev = await tx.$queryRaw<{ status: string; organizer_id: string }[]>`
        SELECT status::text AS status, organizer_id FROM events WHERE id = ${order.event_id}::uuid`;
      if (ev[0]!.status === 'cancelled') throw new AppError('EVENT_CANCELLED');
      await tx.$executeRaw`UPDATE payments SET status = 'succeeded', updated_at = now() WHERE id = ${p.id}::uuid`;
      const now = await dbNow(tx);
      const onTime =
        (order.status === 'holding' || order.status === 'awaiting_payment') &&
        order.expires_at > now;
      if (onTime) {
        await finalizePaid(tx, order, ev[0]!.organizer_id, 'payment succeeded', sink);
      } else {
        await reholdOrder(tx, order);
        await finalizePaid(
          tx,
          order,
          ev[0]!.organizer_id,
          'late payment: seats were still free',
          sink,
        );
      }
      return {
        outcome: 'paid',
        eventId: order.event_id,
        orderId: order.id,
        userId: order.user_id,
        changes: sink,
      };
    }, TX);
  } catch (err) {
    const code = err instanceof AppError ? err.code : dbErrorCode(err);
    if (!code || !refundable.has(code)) throw err;
  }
  return refundLatePayment(prisma, providerRef);
}

async function refundLatePayment(
  prisma: PrismaClient,
  providerRef: string,
): Promise<PaymentOutcome> {
  return prisma.$transaction(async (tx) => {
    const sink: ChangesByEvent = new Map();
    if (!(await claimWebhook(tx, providerRef, 'payment.succeeded'))) return none('duplicate');
    const pay = await tx.$queryRaw<{ id: string; order_id: string; status: string }[]>`
      SELECT id, order_id, status::text AS status FROM payments WHERE provider_ref = ${providerRef} FOR UPDATE`;
    const p = pay[0];
    if (!p) throw new AppError('NOT_FOUND', 'Unknown payment');
    if (p.status === 'succeeded') return none('duplicate');
    const order = (await lockOrder(tx, p.order_id))!;
    const organizerId = await organizerOf(tx, order.event_id);
    await tx.$executeRaw`UPDATE payments SET status = 'succeeded', updated_at = now() WHERE id = ${p.id}::uuid`;
    const touched = new Set<string>();
    await releaseOrder(tx, order.id, 'system', 'late payment: seats unavailable', sink, touched);
    await tx.$executeRaw`UPDATE orders SET paid_kop = total_kop, paid_at = app_now() WHERE id = ${order.id}::uuid`;
    await postPaymentLedger(tx, order, organizerId);
    const refundId = await insertRefund(tx, {
      orderId: order.id,
      paymentId: p.id,
      amountKop: order.total_kop,
      feeKop: order.fee_kop,
      kind: 'late_payment',
      key: `late:${p.id}`,
      reason: 'seats no longer available at payment time',
    });
    await addHistory(
      tx,
      order.id,
      'expired',
      'expired',
      'system',
      'late payment refunded in full (seats taken)',
    );
    for (const eventId of touched) await afterSeatsFreed(tx, eventId, sink);
    return {
      outcome: 'refunded_late',
      eventId: order.event_id,
      orderId: order.id,
      userId: order.user_id,
      refundId: refundId ?? undefined,
      changes: sink,
    };
  }, TX);
}

export async function onPaymentFailed(
  prisma: PrismaClient,
  providerRef: string,
): Promise<PaymentOutcome> {
  return prisma.$transaction(async (tx) => {
    if (!(await claimWebhook(tx, providerRef, 'payment.failed'))) return none('duplicate');
    const pay = await tx.$queryRaw<{ id: string; order_id: string; status: string }[]>`
      SELECT id, order_id, status::text AS status FROM payments WHERE provider_ref = ${providerRef} FOR UPDATE`;
    const p = pay[0];
    if (!p) throw new AppError('NOT_FOUND', 'Unknown payment');
    // `failed` arriving after `succeeded` (out-of-order delivery) must never undo a successful payment.
    if (p.status !== 'pending') return none('ignored');
    await tx.$executeRaw`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = ${p.id}::uuid`;
    const order = await lockOrder(tx, p.order_id);
    if (order?.status === 'awaiting_payment') {
      const other = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM payments WHERE order_id = ${order.id}::uuid AND status = 'pending'`;
      if (other[0]!.n === 0) {
        await tx.$executeRaw`UPDATE orders SET status = 'holding' WHERE id = ${order.id}::uuid`;
        await addHistory(tx, order.id, 'awaiting_payment', 'holding', 'system', 'payment failed');
      }
    }
    return { outcome: 'failed', orderId: p.order_id, changes: new Map() };
  }, TX);
}

// ───────────────────────── refunds ─────────────────────────

export interface NewRefund {
  orderId: string;
  paymentId: string | null;
  amountKop: number;
  feeKop: number;
  kind: 'user' | 'cancellation' | 'late_payment' | 'manual';
  key: string;
  reason?: string;
}

/**
 * Inserts the refund row (the DB trigger bumps `orders.refunded_kop` and `orders_refund_le_paid` rejects
 * over-refunds). Caller must hold the order row lock. The existence pre-check replaces ON CONFLICT because
 * BEFORE INSERT triggers run before conflict detection. Returns null when this key was already used.
 */
export async function insertRefund(tx: Db, r: NewRefund): Promise<string | null> {
  const dup = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM refunds WHERE idempotency_key = ${r.key}`;
  if (dup[0]) return null;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO refunds (order_id, payment_id, amount_kop, fee_kop, kind, idempotency_key, reason)
    VALUES (${r.orderId}::uuid, ${r.paymentId}::uuid, ${r.amountKop}::bigint, ${r.feeKop}::bigint, ${r.kind},
            ${r.key}, ${r.reason ?? null}) RETURNING id`;
  return rows[0]!.id;
}

/**
 * Sends a pending refund to the provider. Claimed by a lease (`locked_until`), so concurrent workers/api
 * instances never send one refund twice; the provider call is itself idempotent on the refund id.
 * 429/503 → retry later with exponential backoff; attempts exhausted → `failed` + visible to finance.
 */
export async function dispatchRefund(
  prisma: PrismaClient,
  stub: StubClient,
  refundId: string,
): Promise<'sent' | 'retry' | 'failed' | 'skipped'> {
  const claimed = await prisma.$queryRaw<
    {
      id: string;
      amount_kop: number;
      provider_ref: string | null;
      attempts: number;
      payment_ref: string | null;
      status: string;
    }[]
  >`
    UPDATE refunds r SET locked_until = app_now() + interval '30 seconds', attempts = r.attempts + 1, updated_at = now()
    WHERE r.id = ${refundId}::uuid AND r.status = 'pending' AND (r.locked_until IS NULL OR r.locked_until <= app_now())
    RETURNING r.id, r.amount_kop::float8 AS amount_kop, r.provider_ref, r.attempts, r.status::text AS status,
      (SELECT p.provider_ref FROM payments p WHERE p.id = r.payment_id) AS payment_ref`;
  const r = claimed[0];
  if (!r) return 'skipped';
  if (!r.payment_ref) return failRefund(prisma, r.id, r.attempts, 'refund has no provider payment');
  const res = await stub.createRefund({
    merchantRef: r.id,
    paymentRef: r.payment_ref,
    amountKop: r.amount_kop,
  });
  if (res.ok) {
    await prisma.$executeRaw`
      UPDATE refunds SET status = 'sent', provider_ref = ${res.data.providerRef}, locked_until = NULL, updated_at = now()
      WHERE id = ${r.id}::uuid`;
    if (res.data.status === 'succeeded') {
      // Webhook may be delayed/dropped; the provider already says done, so apply it now (idempotent).
      await prisma.$transaction((tx) => completeRefund(tx, r.id), TX);
    }
    return 'sent';
  }
  if (!res.retryable || r.attempts >= MAX_REFUND_ATTEMPTS) {
    return failRefund(prisma, r.id, r.attempts, `provider answered ${res.status}`);
  }
  const backoff = Math.min(2 ** r.attempts, 60);
  await prisma.$executeRaw`
    UPDATE refunds SET locked_until = app_now() + make_interval(secs => ${backoff}::float8) WHERE id = ${r.id}::uuid`;
  return 'retry';
}

async function failRefund(
  prisma: Db,
  id: string,
  attempts: number,
  error: string,
): Promise<'failed'> {
  await prisma.$executeRaw`UPDATE refunds SET status = 'failed', locked_until = NULL, updated_at = now() WHERE id = ${id}::uuid`;
  await prisma.$executeRaw`
    INSERT INTO failed_jobs (queue, job_key, payload, error, attempts)
    VALUES ('refund', ${id}, ${JSON.stringify({ refundId: id })}::jsonb, ${error}, ${attempts})
    ON CONFLICT (queue, job_key) DO UPDATE SET error = EXCLUDED.error, attempts = EXCLUDED.attempts, failed_at = now(), retried_at = NULL`;
  return 'failed';
}

/** Provider confirmed the refund: post the ledger once, advance cancel progress. Idempotent. */
export async function completeRefund(
  tx: Db,
  refundId: string,
): Promise<{ eventId: string; orderId: string; kind: string; done: boolean } | null> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      order_id: string;
      amount_kop: number;
      fee_kop: number;
      kind: string;
      status: string;
    }[]
  >`SELECT id, order_id, amount_kop::float8 AS amount_kop, fee_kop::float8 AS fee_kop, kind, status::text AS status
    FROM refunds WHERE id = ${refundId}::uuid FOR UPDATE`;
  const r = rows[0];
  if (!r) throw new AppError('NOT_FOUND', 'Unknown refund');
  const order = (await lockOrder(tx, r.order_id))!;
  if (r.status === 'done') return null;
  await tx.$executeRaw`UPDATE refunds SET status = 'done', locked_until = NULL, updated_at = now() WHERE id = ${r.id}::uuid`;
  await postRefundLedger(tx, r, await organizerOf(tx, order.event_id));
  await addHistory(
    tx,
    order.id,
    order.status,
    order.status,
    'system',
    `refund ${r.kind} done: ${r.amount_kop} kop`,
  );
  if (r.kind === 'cancellation') {
    await tx.$executeRaw`
      UPDATE cancel_batches SET done = done + 1,
        status = CASE WHEN done + 1 >= total THEN 'done' ELSE status END,
        finished_at = CASE WHEN done + 1 >= total THEN now() ELSE finished_at END
      WHERE event_id = ${order.event_id}::uuid`;
  }
  const user = await tx.$queryRaw<
    { email: string }[]
  >`SELECT email FROM users WHERE id = ${order.user_id}::uuid`;
  if (user[0]) {
    await queueEmail(
      tx,
      `refund:${r.id}`,
      user[0].email,
      'Refund processed',
      `Refund of ${r.amount_kop / 100} UAH for order ${order.id} was processed.`,
    );
  }
  return { eventId: order.event_id, orderId: order.id, kind: r.kind, done: true };
}

export async function onRefundEvent(
  prisma: PrismaClient,
  type: 'refund.succeeded' | 'refund.failed',
  providerRef: string,
): Promise<{ eventId: string; kind: string } | null> {
  return prisma.$transaction(async (tx) => {
    if (!(await claimWebhook(tx, providerRef, type))) return null;
    const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text AS status FROM refunds WHERE provider_ref = ${providerRef}`;
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Unknown refund');
    if (type === 'refund.failed') {
      if (rows[0].status !== 'done')
        await failRefund(tx, rows[0].id, 0, 'provider reported refund failure');
      return null;
    }
    const done = await completeRefund(tx, rows[0].id);
    return done ? { eventId: done.eventId, kind: done.kind } : null;
  }, TX);
}

// ───────────────────────── reconciliation (provider status API) ─────────────────────────

export interface Discrepancy {
  kind: 'payment' | 'refund';
  id: string;
  providerRef: string;
  ours: string;
  provider: string;
  resolved: boolean;
}

/**
 * Finds operations stuck because a webhook was dropped/delayed and applies the provider's state through the
 * same idempotent handlers as webhooks. Runs every minute from the worker (and on demand for finance).
 * With `apply=false` it only reports.
 */
export async function reconcileProvider(
  prisma: PrismaClient,
  stub: StubClient,
  opts: { apply: boolean; olderThanSeconds: number; limit: number },
): Promise<{ discrepancies: Discrepancy[]; outcomes: PaymentOutcome[] }> {
  const discrepancies: Discrepancy[] = [];
  const outcomes: PaymentOutcome[] = [];
  const pays = await prisma.$queryRaw<{ id: string; provider_ref: string; status: string }[]>`
    SELECT id, provider_ref, status::text AS status FROM payments
    WHERE provider_ref IS NOT NULL AND status = 'pending'
      AND created_at < now() - make_interval(secs => ${opts.olderThanSeconds}::float8)
    ORDER BY created_at LIMIT ${opts.limit}`;
  for (const p of pays) {
    const res = await stub.getPayment(p.provider_ref);
    if (!res.ok) {
      if (res.retryable) break; // rate limited / provider down: try again next minute
      continue;
    }
    if (res.data.status === 'pending') continue;
    const d: Discrepancy = {
      kind: 'payment',
      id: p.id,
      providerRef: p.provider_ref,
      ours: p.status,
      provider: res.data.status,
      resolved: false,
    };
    if (opts.apply) {
      const out =
        res.data.status === 'succeeded'
          ? await onPaymentSucceeded(prisma, p.provider_ref)
          : await onPaymentFailed(prisma, p.provider_ref);
      outcomes.push(out);
      d.resolved = true;
    }
    discrepancies.push(d);
  }
  const refunds = await prisma.$queryRaw<{ id: string; provider_ref: string; status: string }[]>`
    SELECT id, provider_ref, status::text AS status FROM refunds
    WHERE provider_ref IS NOT NULL AND status = 'sent'
      AND updated_at < now() - make_interval(secs => ${opts.olderThanSeconds}::float8)
    ORDER BY updated_at LIMIT ${opts.limit}`;
  for (const r of refunds) {
    const res = await stub.getRefund(r.provider_ref);
    if (!res.ok) {
      if (res.retryable) break;
      continue;
    }
    const d: Discrepancy = {
      kind: 'refund',
      id: r.id,
      providerRef: r.provider_ref,
      ours: r.status,
      provider: res.data.status,
      resolved: false,
    };
    if (opts.apply) {
      await onRefundEvent(
        prisma,
        res.data.status === 'succeeded' ? 'refund.succeeded' : 'refund.failed',
        r.provider_ref,
      );
      d.resolved = true;
    }
    discrepancies.push(d);
  }
  return { discrepancies, outcomes };
}

export { getOrder };
