import { Injectable, Logger } from '@nestjs/common';
import { holdSeats, holdZone, redeemPromo, type Db } from '@tickets/db';
import { calcRefund, HOLD_TTL_MS, MAX_SEATS_PER_HOLD, type EventStatus } from '@tickets/shared';
import type { z } from 'zod';
import type { ChangeHoldSchema, CreateHoldSchema } from '@tickets/shared';
import type { OrderDto, RefundDto } from '../../common/dto.js';
import {
  addHistory,
  dbNow,
  getOrder,
  lockOrder,
  recomputeOrder,
  recordSeatChanges,
  refreshSoldOut,
  type SeatChange,
} from '@tickets/domain';
import { afterSeatsFreed, pushChanges, releaseOrder, type ChangesByEvent } from '@tickets/domain';
import { dispatchRefund, insertRefund } from '@tickets/domain';
import { AppError } from '@tickets/domain';
import { PrismaService, RealtimeService, StubApi } from '../../common/infra.js';
import { QueueService } from '../queue/queue.service.js';

type OrderOut = z.infer<typeof OrderDto>;
type RefundOut = z.infer<typeof RefundDto>;

interface SaleEvent {
  id: string;
  venue_id: string;
  organizer_id: string;
  status: string;
  sales_start: Date | null;
  starts_at: Date;
  rescheduled_at: Date | null;
}

interface PricedItem {
  zoneId: string;
  seatId: number | null;
  priceKop: number;
}

const TX = { maxWait: 60_000, timeout: 60_000 } as const;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly queue: QueueService,
    private readonly stub: StubApi,
  ) {}

  // ───────────────────────── helpers ─────────────────────────

  async loadSaleEvent(db: Db, eventId: string): Promise<SaleEvent> {
    const rows = await db.$queryRaw<SaleEvent[]>`
      SELECT id, venue_id, organizer_id, status::text AS status, sales_start, starts_at, rescheduled_at
      FROM events WHERE id = ${eventId}::uuid`;
    const ev = rows[0];
    if (!ev || ev.status === 'draft') throw new AppError('NOT_FOUND', 'Event not found');
    if (ev.status === 'cancelled') throw new AppError('EVENT_CANCELLED', 'The event was cancelled');
    if (!['on_sale', 'sold_out', 'rescheduled'].includes(ev.status)) {
      throw new AppError('EVENT_NOT_ON_SALE', 'Tickets are not on sale for this event');
    }
    const now = await dbNow(db);
    if (ev.sales_start && ev.sales_start > now) {
      throw new AppError('EVENT_NOT_ON_SALE', 'Sales have not started yet', {
        salesStart: ev.sales_start.toISOString(),
      });
    }
    if (ev.starts_at <= now)
      throw new AppError('EVENT_NOT_ON_SALE', 'The event has already started');
    return ev;
  }

  /** Prices seats/dancefloor tickets for the event; anything unpriced, foreign or unknown is unavailable. */
  private async priceItems(
    db: Db,
    ev: SaleEvent,
    seatIds: number[],
    zones: { zoneId: string; quantity: number }[],
  ): Promise<PricedItem[]> {
    const items: PricedItem[] = [];
    if (seatIds.length) {
      const rows = await db.$queryRaw<{ id: number; zone_id: string; price: number | null }[]>`
        SELECT s.id::float8 AS id, s.zone_id, COALESCE(sp.price_kop, zp.price_kop)::float8 AS price
        FROM seats s
        LEFT JOIN event_seat_prices sp ON sp.event_id = ${ev.id}::uuid AND sp.seat_id = s.id
        LEFT JOIN event_zone_prices zp ON zp.event_id = ${ev.id}::uuid AND zp.zone_id = s.zone_id
        WHERE s.venue_id = ${ev.venue_id}::uuid AND s.id = ANY (${seatIds}::bigint[])`;
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of seatIds) {
        const r = byId.get(id);
        if (!r || r.price === null)
          throw new AppError('SEATS_UNAVAILABLE', 'Seat is not for sale', { seatId: id });
        items.push({ zoneId: r.zone_id, seatId: id, priceKop: r.price });
      }
    }
    for (const z of zones) {
      const rows = await db.$queryRaw<{ price: number }[]>`
        SELECT zp.price_kop::float8 AS price FROM zones z
        JOIN event_zone_prices zp ON zp.zone_id = z.id AND zp.event_id = ${ev.id}::uuid
        WHERE z.id = ${z.zoneId}::uuid AND z.venue_id = ${ev.venue_id}::uuid AND z.kind = 'dancefloor'`;
      if (!rows[0])
        throw new AppError('SEATS_UNAVAILABLE', 'Zone is not for sale', { zoneId: z.zoneId });
      for (let i = 0; i < z.quantity; i++)
        items.push({ zoneId: z.zoneId, seatId: null, priceKop: rows[0].price });
    }
    return items;
  }

  private publish(sink: ChangesByEvent): void {
    for (const [eventId, changes] of sink) this.realtime.seatChanges(eventId, changes);
  }

  /** After a transaction: sold_out flag, queue slots, socket fan-out (never blocks correctness). */
  private async afterCommit(eventId: string, sink: ChangesByEvent, userId?: string): Promise<void> {
    this.publish(sink);
    try {
      const flip = await refreshSoldOut(this.prisma.db, eventId);
      if (flip) this.realtime.seatChanges(eventId, []);
      if (userId) await this.queue.tick(eventId);
    } catch (err) {
      this.logger.warn(
        `post-commit refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ───────────────────────── holds ─────────────────────────

  async createHold(userId: string, input: z.infer<typeof CreateHoldSchema>): Promise<OrderOut> {
    const db = this.prisma.db;
    const ev = await this.loadSaleEvent(db, input.eventId);
    await this.queue.assertAdmitted(ev.id, userId);
    const items = await this.priceItems(db, ev, input.seatIds, input.zones);
    const sink: ChangesByEvent = new Map();
    const orderId = await db.$transaction(async (tx) => {
      const created = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO orders (user_id, event_id, expires_at)
        VALUES (${userId}::uuid, ${ev.id}::uuid, app_now() + interval '10 minutes') RETURNING id`;
      const id = created[0]!.id;
      const ttlSeconds = HOLD_TTL_MS / 1000;
      const expiries: Date[] = [];
      if (input.seatIds.length) {
        expiries.push(
          await holdSeats(tx, {
            eventId: ev.id,
            userId,
            orderId: id,
            seatIds: input.seatIds.map(BigInt),
            ttlSeconds,
          }),
        );
      }
      for (const z of input.zones) {
        expiries.push(
          await holdZone(tx, {
            eventId: ev.id,
            zoneId: z.zoneId,
            userId,
            orderId: id,
            qty: z.quantity,
            ttlSeconds,
          }),
        );
      }
      const expires = new Date(Math.min(...expiries.map((d) => d.getTime())));
      await tx.$executeRaw`UPDATE orders SET expires_at = ${expires} WHERE id = ${id}::uuid`;
      await tx.$executeRaw`UPDATE seat_holds SET expires_at = ${expires} WHERE order_id = ${id}::uuid AND status = 'held'`;
      await tx.$executeRaw`UPDATE zone_holds SET expires_at = ${expires} WHERE order_id = ${id}::uuid AND status = 'held'`;
      for (const it of items) {
        await tx.$executeRaw`
          INSERT INTO order_items (order_id, event_id, zone_id, seat_id, price_kop)
          VALUES (${id}::uuid, ${ev.id}::uuid, ${it.zoneId}::uuid, ${it.seatId}::bigint, ${it.priceKop}::bigint)`;
      }
      await recomputeOrder(tx, id);
      await addHistory(
        tx,
        id,
        null,
        'holding',
        `user:${userId}`,
        `hold created (${items.length} tickets)`,
      );
      await this.queue.markSelecting(tx, ev.id, userId);
      pushChanges(
        sink,
        ev.id,
        await recordSeatChanges(tx, ev.id, [
          ...input.seatIds.map((s) => ({ seatId: s, state: 'held' as const })),
          ...input.zones.map((z) => ({ zoneId: z.zoneId, state: 'held' as const })),
        ]),
      );
      return id;
    }, TX);
    await this.afterCommit(ev.id, sink, userId);
    return this.orderDto(orderId);
  }

  async changeSeats(
    userId: string,
    orderId: string,
    input: z.infer<typeof ChangeHoldSchema>,
  ): Promise<OrderOut> {
    const db = this.prisma.db;
    const sink: ChangesByEvent = new Map();
    let eventId = '';
    await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (!order || order.user_id !== userId) throw new AppError('NOT_FOUND', 'Order not found');
      eventId = order.event_id;
      if (order.status !== 'holding')
        throw new AppError('INVALID_STATE', `Order is ${order.status}`);
      const now = await dbNow(tx);
      if (order.expires_at <= now)
        throw new AppError('HOLD_EXPIRED', 'The hold on these seats has expired');
      const ev = await this.loadSaleEvent(tx, order.event_id);
      const current = await tx.$queryRaw<{ id: string; seat_id: number | null; zone_id: string }[]>`
        SELECT id, seat_id::float8 AS seat_id, zone_id FROM order_items WHERE order_id = ${orderId}::uuid`;
      const removeIds = new Set(input.removeSeatIds);
      const toRemove = current.filter((c) => c.seat_id !== null && removeIds.has(c.seat_id));
      if (toRemove.length !== removeIds.size)
        throw new AppError('VALIDATION_ERROR', 'Seat is not part of this order');
      const addIds = input.addSeatIds.filter(
        (s) => !current.some((c) => c.seat_id === s) || removeIds.has(s),
      );
      if (current.length - toRemove.length + addIds.length > MAX_SEATS_PER_HOLD) {
        throw new AppError('VALIDATION_ERROR', `At most ${MAX_SEATS_PER_HOLD} tickets per order`);
      }
      const changes: SeatChange[] = [];
      if (toRemove.length) {
        const ids = toRemove.map((r) => r.seat_id as number);
        await tx.$executeRaw`DELETE FROM order_items WHERE id = ANY (${toRemove.map((r) => r.id)}::uuid[])`;
        await tx.$executeRaw`
          UPDATE seat_holds SET status = 'released'
          WHERE order_id = ${orderId}::uuid AND seat_id = ANY (${ids}::bigint[]) AND status = 'held'`;
        changes.push(
          ...(await recordSeatChanges(
            tx,
            ev.id,
            ids.map((s) => ({ seatId: s, state: 'free' as const })),
          )),
        );
      }
      if (addIds.length) {
        const priced = await this.priceItems(tx, ev, addIds, []);
        await holdSeats(tx, {
          eventId: ev.id,
          userId,
          orderId,
          seatIds: addIds.map(BigInt),
          ttlSeconds: HOLD_TTL_MS / 1000,
        });
        // Adding seats never extends the timer: new holds inherit the order's original deadline.
        await tx.$executeRaw`UPDATE seat_holds SET expires_at = ${order.expires_at} WHERE order_id = ${orderId}::uuid AND status = 'held'`;
        for (const it of priced) {
          await tx.$executeRaw`
            INSERT INTO order_items (order_id, event_id, zone_id, seat_id, price_kop)
            VALUES (${orderId}::uuid, ${ev.id}::uuid, ${it.zoneId}::uuid, ${it.seatId}::bigint, ${it.priceKop}::bigint)`;
        }
        changes.push(
          ...(await recordSeatChanges(
            tx,
            ev.id,
            addIds.map((s) => ({ seatId: s, state: 'held' as const })),
          )),
        );
      }
      const left = current.length - toRemove.length + addIds.length;
      if (left === 0) {
        await releaseOrder(tx, orderId, `user:${userId}`, 'last seat removed', sink, new Set());
      } else {
        await recomputeOrder(tx, orderId);
        await addHistory(
          tx,
          orderId,
          'holding',
          'holding',
          `user:${userId}`,
          `seats changed (+${addIds.length}/-${toRemove.length})`,
        );
      }
      pushChanges(sink, ev.id, changes);
      if (toRemove.length) await afterSeatsFreed(tx, ev.id, sink);
    }, TX);
    await this.afterCommit(eventId, sink, userId);
    return this.orderDto(orderId);
  }

  async release(userId: string, orderId: string): Promise<OrderOut> {
    const sink: ChangesByEvent = new Map();
    const touched = new Set<string>();
    await this.prisma.db.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (!order || order.user_id !== userId) throw new AppError('NOT_FOUND', 'Order not found');
      if (order.status !== 'holding')
        throw new AppError('INVALID_STATE', `Order is ${order.status}`);
      await releaseOrder(tx, orderId, `user:${userId}`, 'released by user', sink, touched);
      for (const e of touched) await afterSeatsFreed(tx, e, sink);
    }, TX);
    for (const e of touched) await this.afterCommit(e, sink, userId);
    return this.orderDto(orderId);
  }

  // ───────────────────────── promo ─────────────────────────

  async applyPromo(userId: string, orderId: string, code: string): Promise<OrderOut> {
    await this.prisma.db.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (!order || order.user_id !== userId) throw new AppError('NOT_FOUND', 'Order not found');
      if (order.status !== 'holding')
        throw new AppError('INVALID_STATE', `Order is ${order.status}`);
      if (order.promo_id) throw new AppError('INVALID_STATE', 'A promo code is already applied');
      const promos = await tx.$queryRaw<
        { id: string; used: number; usage_limit: number; expired: boolean }[]
      >`
        SELECT id, used, usage_limit, (valid_until IS NOT NULL AND valid_until <= app_now()) AS expired
        FROM promo_codes WHERE event_id = ${order.event_id}::uuid AND upper(code) = upper(${code})`;
      const p = promos[0];
      if (!p || p.expired)
        throw new AppError('PROMO_INVALID', 'Promo code is not valid for this event');
      if (!(await redeemPromo(tx, p.id, orderId, userId))) {
        throw new AppError('PROMO_EXHAUSTED', 'Promo code usage limit reached');
      }
      await tx.$executeRaw`UPDATE orders SET promo_id = ${p.id}::uuid WHERE id = ${orderId}::uuid`;
      await recomputeOrder(tx, orderId);
      await addHistory(
        tx,
        orderId,
        'holding',
        'holding',
        `user:${userId}`,
        `promo applied: ${code}`,
      );
    }, TX);
    return this.orderDto(orderId);
  }

  // ───────────────────────── reads ─────────────────────────

  async orderDto(orderId: string, requireUser?: string): Promise<OrderOut> {
    const db = this.prisma.db;
    const o = await getOrder(db, orderId);
    if (!o || (requireUser && o.user_id !== requireUser))
      throw new AppError('NOT_FOUND', 'Order not found');
    const promo = await db.$queryRaw<
      { code: string }[]
    >`SELECT code FROM promo_codes WHERE id = ${o.promo_id}::uuid`;
    const items = await db.$queryRaw<
      {
        id: string;
        zone_id: string;
        seat_id: number | null;
        price: number;
        discount: number;
        fee: number;
        refunded: boolean;
      }[]
    >`SELECT id, zone_id, seat_id::float8 AS seat_id, price_kop::float8 AS price, discount_kop::float8 AS discount,
             fee_kop::float8 AS fee, refunded FROM order_items WHERE order_id = ${orderId}::uuid ORDER BY id`;
    const now = await dbNow(db);
    return {
      id: o.id,
      eventId: o.event_id,
      status: o.status as OrderOut['status'],
      expiresAt: o.expires_at.toISOString(),
      serverNow: now.toISOString(),
      promoCode: promo[0]?.code ?? null,
      subtotalKop: o.subtotal_kop,
      discountKop: o.discount_kop,
      feeKop: o.fee_kop,
      totalKop: o.total_kop,
      paidKop: o.paid_kop,
      refundedKop: o.refunded_kop,
      items: items.map((i) => ({
        id: i.id,
        zoneId: i.zone_id,
        seatId: i.seat_id,
        priceKop: i.price,
        discountKop: i.discount,
        feeKop: i.fee,
        refunded: i.refunded,
      })),
    };
  }

  async listOrders(userId: string): Promise<OrderOut[]> {
    const ids = await this.prisma.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders WHERE user_id = ${userId}::uuid ORDER BY created_at DESC LIMIT 100`;
    return Promise.all(ids.map((r) => this.orderDto(r.id)));
  }

  async history(userId: string, orderId: string) {
    await this.orderDto(orderId, userId);
    const rows = await this.prisma.db.$queryRaw<
      {
        id: number;
        from_status: string | null;
        to_status: string;
        actor: string;
        note: string | null;
        at: Date;
      }[]
    >`SELECT id::float8 AS id, from_status::text AS from_status, to_status::text AS to_status, actor, note, created_at AS at
      FROM order_history WHERE order_id = ${orderId}::uuid ORDER BY id`;
    return {
      items: rows.map((r) => ({
        id: r.id,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        actor: r.actor,
        note: r.note,
        at: r.at.toISOString(),
      })),
    };
  }

  // ───────────────────────── refunds ─────────────────────────

  /** Buyer returns tickets per the spec rules (>7d full price, 2-7d 50%, <2d refused, cancelled/rescheduled rules). */
  async requestRefund(
    userId: string,
    orderId: string,
    ticketIds: string[] | undefined,
    key: string,
  ): Promise<RefundOut> {
    const sink: ChangesByEvent = new Map();
    const result = await this.prisma.db.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (!order || order.user_id !== userId) throw new AppError('NOT_FOUND', 'Order not found');
      if (order.status === 'refunded') {
        throw new AppError('REFUND_EXCEEDS_PAID', 'This order was already refunded');
      }
      if (order.status !== 'paid' && order.status !== 'partially_refunded') {
        throw new AppError('INVALID_STATE', `Order is ${order.status}`);
      }
      const evs = await tx.$queryRaw<
        { status: string; starts_at: Date; rescheduled_at: Date | null }[]
      >`
        SELECT status::text AS status, starts_at, rescheduled_at FROM events WHERE id = ${order.event_id}::uuid`;
      const ev = evs[0]!;
      const now = await dbNow(tx);
      const tickets = await tx.$queryRaw<
        {
          id: string;
          owner_id: string;
          status: string;
          seat_id: number | null;
          zone_id: string;
          item_id: string;
          paid: number;
          fee: number;
        }[]
      >`SELECT t.id, t.owner_id, t.status::text AS status, t.seat_id::float8 AS seat_id, t.zone_id, oi.id AS item_id,
               (oi.price_kop - oi.discount_kop)::float8 AS paid, oi.fee_kop::float8 AS fee
        FROM tickets t JOIN order_items oi ON oi.id = t.order_item_id WHERE oi.order_id = ${orderId}::uuid ORDER BY t.id`;
      const wanted = ticketIds ? new Set(ticketIds) : null;
      if (wanted && tickets.filter((t) => wanted.has(t.id)).length !== wanted.size) {
        throw new AppError('NOT_FOUND', 'Ticket not found in this order');
      }
      const pool = wanted ? tickets.filter((t) => wanted.has(t.id)) : tickets;
      const selected = pool.filter((t) => t.status === 'valid' && t.owner_id === userId);
      const alreadyRefunded = pool.some((t) => t.status === 'refunded' || t.status === 'cancelled');
      if (!selected.length || (wanted && selected.length !== wanted.size)) {
        if (alreadyRefunded)
          throw new AppError('REFUND_EXCEEDS_PAID', 'These tickets were already refunded');
        throw new AppError(
          'INVALID_STATE',
          'Tickets cannot be refunded (used, transferred or not found)',
        );
      }
      // Rescheduled events keep their reschedule marker even while sold_out (status flips back and forth).
      const evStatus = (
        ev.rescheduled_at && ev.status !== 'cancelled' ? 'rescheduled' : ev.status
      ) as EventStatus;
      let total = 0;
      let fee = 0;
      for (const t of selected) {
        const d = calcRefund({
          ticketPaidKop: t.paid,
          feeKop: t.fee,
          eventStatus: evStatus,
          startsAt: ev.starts_at,
          rescheduledAt: ev.rescheduled_at,
          now,
        });
        if (!d.allowed)
          throw new AppError(d.code, 'Refunds are closed for this event', {
            startsAt: ev.starts_at.toISOString(),
          });
        total += d.amountKop;
        if (d.includesFee) fee += t.fee;
      }
      if (total <= 0) throw new AppError('INVALID_STATE', 'Nothing to refund');
      const pay = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM payments WHERE order_id = ${orderId}::uuid AND status = 'succeeded' ORDER BY created_at LIMIT 1`;
      const refundId = await insertRefund(tx, {
        orderId,
        paymentId: pay[0]?.id ?? null,
        amountKop: total,
        feeKop: fee,
        kind: 'user',
        key: `user:${orderId}:${key}`,
      });
      if (!refundId) throw new AppError('CONFLICT', 'Refund request already registered');
      await this.invalidateTickets(tx, orderId, order.event_id, selected, sink);
      const remaining = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM order_items WHERE order_id = ${orderId}::uuid AND NOT refunded`;
      const to = remaining[0]!.n === 0 ? 'refunded' : 'partially_refunded';
      await tx.$executeRaw`UPDATE orders SET status = ${to}::order_status WHERE id = ${orderId}::uuid`;
      await addHistory(
        tx,
        orderId,
        order.status,
        to,
        `user:${userId}`,
        `refund requested for ${selected.length} ticket(s): ${total} kop`,
      );
      await afterSeatsFreed(tx, order.event_id, sink);
      return { refundId, total, fee, eventId: order.event_id };
    }, TX);
    await this.afterCommit(result.eventId, sink);
    this.dispatchLater(result.refundId);
    return {
      id: result.refundId,
      orderId,
      amountKop: result.total,
      feeKop: result.fee,
      kind: 'user',
      status: 'pending',
    };
  }

  /** Marks tickets refunded and frees their seats / dancefloor capacity. */
  async invalidateTickets(
    tx: Db,
    orderId: string,
    eventId: string,
    tickets: { id: string; seat_id: number | null; zone_id: string; item_id: string }[],
    sink: ChangesByEvent,
  ): Promise<void> {
    await tx.$executeRaw`UPDATE tickets SET status = 'refunded' WHERE id = ANY (${tickets.map((t) => t.id)}::uuid[])`;
    await tx.$executeRaw`UPDATE order_items SET refunded = true WHERE id = ANY (${tickets.map((t) => t.item_id)}::uuid[])`;
    const seatIds = tickets.filter((t) => t.seat_id !== null).map((t) => t.seat_id as number);
    const changes: SeatChange[] = [];
    if (seatIds.length) {
      await tx.$executeRaw`
        UPDATE seat_holds SET status = 'released'
        WHERE order_id = ${orderId}::uuid AND seat_id = ANY (${seatIds}::bigint[]) AND status = 'sold'`;
      changes.push(
        ...(await recordSeatChanges(
          tx,
          eventId,
          seatIds.map((s) => ({ seatId: s, state: 'free' as const })),
        )),
      );
    }
    const perZone = new Map<string, number>();
    for (const t of tickets.filter((x) => x.seat_id === null))
      perZone.set(t.zone_id, (perZone.get(t.zone_id) ?? 0) + 1);
    for (const [zoneId, k] of perZone) {
      await tx.$executeRaw`
        UPDATE zone_holds SET status = CASE WHEN qty <= ${k}::int THEN 'released'::hold_status ELSE status END,
                              qty = CASE WHEN qty <= ${k}::int THEN qty ELSE qty - ${k}::int END
        WHERE order_id = ${orderId}::uuid AND zone_id = ${zoneId}::uuid AND status = 'sold'`;
      changes.push(...(await recordSeatChanges(tx, eventId, [{ zoneId, state: 'free' }])));
    }
    pushChanges(sink, eventId, changes);
  }

  /** Finance: money-only refund with a reason; capped by the DB (refunded <= paid) under any concurrency. */
  async manualRefund(
    actorId: string,
    input: { orderId: string; amountKop: number; reason: string },
    key: string,
  ): Promise<RefundOut> {
    const sink: ChangesByEvent = new Map();
    const out = await this.prisma.db.$transaction(async (tx) => {
      const order = await lockOrder(tx, input.orderId);
      if (!order) throw new AppError('NOT_FOUND', 'Order not found');
      if (order.paid_kop <= 0) throw new AppError('INVALID_STATE', 'Order has no payment');
      if (order.refunded_kop + input.amountKop > order.paid_kop) {
        throw new AppError('REFUND_EXCEEDS_PAID', 'Refund would exceed the amount paid', {
          paidKop: order.paid_kop,
          refundedKop: order.refunded_kop,
        });
      }
      const pay = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM payments WHERE order_id = ${input.orderId}::uuid AND status = 'succeeded' ORDER BY created_at LIMIT 1`;
      const refundId = await insertRefund(tx, {
        orderId: input.orderId,
        paymentId: pay[0]?.id ?? null,
        amountKop: input.amountKop,
        feeKop: 0,
        kind: 'manual',
        key: `manual:${input.orderId}:${key}`,
        reason: input.reason,
      });
      if (!refundId) throw new AppError('CONFLICT', 'Refund request already registered');
      const fully = order.refunded_kop + input.amountKop >= order.paid_kop;
      let to = order.status;
      if (fully) {
        const valid = await tx.$queryRaw<
          { id: string; seat_id: number | null; zone_id: string; item_id: string }[]
        >`
          SELECT t.id, t.seat_id::float8 AS seat_id, t.zone_id, t.order_item_id AS item_id
          FROM tickets t JOIN order_items oi ON oi.id = t.order_item_id
          WHERE oi.order_id = ${input.orderId}::uuid AND t.status = 'valid'`;
        if (valid.length)
          await this.invalidateTickets(tx, input.orderId, order.event_id, valid, sink);
        to = 'refunded';
      } else if (order.status === 'paid') {
        to = 'partially_refunded';
      }
      if (to !== order.status)
        await tx.$executeRaw`UPDATE orders SET status = ${to}::order_status WHERE id = ${input.orderId}::uuid`;
      await addHistory(
        tx,
        input.orderId,
        order.status,
        to,
        `finance:${actorId}`,
        `manual refund ${input.amountKop} kop: ${input.reason}`,
      );
      await afterSeatsFreed(tx, order.event_id, sink);
      return { refundId, eventId: order.event_id };
    }, TX);
    await this.afterCommit(out.eventId, sink);
    this.dispatchLater(out.refundId);
    return {
      id: out.refundId,
      orderId: input.orderId,
      amountKop: input.amountKop,
      feeKop: 0,
      kind: 'manual',
      status: 'pending',
    };
  }

  /** Best-effort immediate send; the worker's refund sweeper retries anything left pending. */
  dispatchLater(refundId: string): void {
    dispatchRefund(this.prisma.db, this.stub, refundId).catch((err: unknown) =>
      this.logger.warn(
        `refund dispatch ${refundId} deferred: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}
