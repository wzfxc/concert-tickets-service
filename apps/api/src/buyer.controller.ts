import { Controller, Delete, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ApplyPromoSchema,
  ChangeHoldSchema,
  CreateHoldSchema,
  PayOrderSchema,
  RefundRequestSchema,
  TRANSFER_CUTOFF_MS,
  TransferSchema,
  WaitlistJoinSchema,
  WebhookEventSchema,
} from '@tickets/shared';
import { signQr } from '@tickets/shared/qr';
import {
  OkDto,
  OrderDto,
  OrderHistoryDto,
  OrderListDto,
  PaymentStartDto,
  QueueStateDto,
  RefundDto,
  TicketListDto,
  WaitlistDto,
} from './dto.js';
import { config } from './config.js';
import { addHistory, dbNow, queueEmail, type SeatChange } from '@tickets/domain';
import { pushChanges, processWaitlist, type ChangesByEvent } from '@tickets/domain';
import {
  onPaymentFailed,
  onPaymentSucceeded,
  onRefundEvent,
  startPayment,
  type PaymentOutcome,
} from '@tickets/domain';
import { AppError } from '@tickets/domain';
import { IdempotencyService } from './idempotency.js';
import { PrismaService, RealtimeService, StubApi } from './infra.js';
import type { AuthUser } from './jwt.js';
import { OrdersService } from './orders.service.js';
import { QueueService } from './queue.service.js';
import { CurrentUser, IdemKey, Route, UuidParam, ZBody, type AppRequest } from './route.js';

const BUYER = ['buyer'] as const;
type Body<T extends z.ZodTypeAny> = z.infer<T>;

@ApiTags('orders')
@Controller()
export class BuyerController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly idem: IdempotencyService,
    private readonly stub: StubApi,
    private readonly realtime: RealtimeService,
    private readonly queue: QueueService,
  ) {}

  // ───────────── holds & orders ─────────────

  @Post('holds')
  @Route({
    summary: 'Hold seats / dancefloor tickets (10 min from the first seat)',
    roles: BUYER,
    body: CreateHoldSchema,
    response: OrderDto,
    status: 201,
    idempotent: true,
  })
  hold(
    @CurrentUser() u: AuthUser,
    @ZBody() body: Body<typeof CreateHoldSchema>,
    @IdemKey() key?: string,
  ) {
    return this.idem.run(`hold:${u.id}`, key, body, () => this.orders.createHold(u.id, body));
  }

  @Get('orders')
  @Route({ summary: 'My orders', roles: BUYER, response: OrderListDto })
  async list(@CurrentUser() u: AuthUser): Promise<z.infer<typeof OrderListDto>> {
    return { items: await this.orders.listOrders(u.id) };
  }

  @Get('orders/:id')
  @Route({ summary: 'My order', roles: BUYER, response: OrderDto })
  get(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    return this.orders.orderDto(id, u.id);
  }

  @Get('orders/:id/history')
  @Route({
    summary: 'Order history: hold, payment, tickets, transfers, refunds, scans',
    roles: BUYER,
    response: OrderHistoryDto,
  })
  history(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    return this.orders.history(u.id, id);
  }

  @Patch('orders/:id/seats')
  @Route({
    summary: 'Add or remove seats while holding (timer is not extended)',
    roles: BUYER,
    body: ChangeHoldSchema,
    response: OrderDto,
  })
  changeSeats(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
    @ZBody() body: Body<typeof ChangeHoldSchema>,
  ) {
    return this.orders.changeSeats(u.id, id, body);
  }

  @Delete('orders/:id')
  @Route({ summary: 'Release the hold (unpaid order)', roles: BUYER, response: OrderDto })
  release(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    return this.orders.release(u.id, id);
  }

  @Post('orders/:id/promo')
  @HttpCode(200)
  @Route({
    summary: 'Apply a promo code (percent or fixed; usage limit enforced atomically)',
    roles: BUYER,
    body: ApplyPromoSchema,
    response: OrderDto,
  })
  promo(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
    @ZBody() body: Body<typeof ApplyPromoSchema>,
  ) {
    return this.orders.applyPromo(u.id, id, body.code);
  }

  // ───────────── payments ─────────────

  @Post('payments')
  @Route({
    summary: 'Start payment for an order (redirect to the payment stub page)',
    roles: BUYER,
    body: PayOrderSchema,
    response: PaymentStartDto,
    status: 201,
    idempotent: true,
  })
  pay(
    @CurrentUser() u: AuthUser,
    @ZBody() body: Body<typeof PayOrderSchema>,
    @IdemKey() key?: string,
  ) {
    return this.idem.run(`pay:${u.id}`, key, body, () =>
      startPayment(this.prisma.db, this.stub, body.orderId, u.id),
    );
  }

  /** Provider webhook: HMAC-SHA256 of the raw body in `x-stub-signature`. Not a user endpoint (no auth, signature only). */
  @Post('payments/webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @Route({ summary: 'Payment provider webhook (HMAC signed)', public: true, response: OkDto })
  async webhook(@Req() req: AppRequest): Promise<z.infer<typeof OkDto>> {
    const raw = req.rawBody ?? Buffer.from('');
    const given = Buffer.from(req.header('x-stub-signature') ?? '', 'utf8');
    const expected = Buffer.from(
      createHmac('sha256', config.webhookSecret).update(raw).digest('hex'),
      'utf8',
    );
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AppError('INVALID_SIGNATURE', 'Bad webhook signature');
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Webhook body is not JSON');
    }
    const evt = WebhookEventSchema.parse(json);
    const db = this.prisma.db;
    if (evt.type === 'payment.succeeded' || evt.type === 'payment.failed') {
      const out: PaymentOutcome =
        evt.type === 'payment.succeeded'
          ? await onPaymentSucceeded(db, evt.providerRef)
          : await onPaymentFailed(db, evt.providerRef);
      await this.afterPayment(out);
    } else {
      const done = await onRefundEvent(db, evt.type, evt.providerRef);
      if (done?.kind === 'cancellation') await this.publishCancelProgress(done.eventId);
    }
    return { ok: true };
  }

  async afterPayment(out: PaymentOutcome): Promise<void> {
    for (const [eventId, changes] of out.changes) this.realtime.seatChanges(eventId, changes);
    if (out.userId)
      this.realtime.toUser(out.userId, 'order:update', {
        orderId: out.orderId,
        outcome: out.outcome,
      });
    if (out.refundId) this.orders.dispatchLater(out.refundId);
    if (out.eventId) await this.queue.tick(out.eventId);
  }

  async publishCancelProgress(eventId: string): Promise<void> {
    const rows = await this.prisma.db.$queryRaw<{ total: number; done: number; status: string }[]>`
      SELECT total, done, status FROM cancel_batches WHERE event_id = ${eventId}::uuid`;
    if (rows[0]) this.realtime.cancelProgress(eventId, { eventId, ...rows[0] });
  }

  // ───────────── refunds ─────────────

  @Post('orders/:id/refunds')
  @Route({
    summary: 'Return tickets (rules: >7d full price, 2-7d 50%, <2d refused)',
    roles: BUYER,
    body: RefundRequestSchema,
    response: RefundDto,
    status: 201,
    idempotent: true,
  })
  refund(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
    @ZBody() body: Body<typeof RefundRequestSchema>,
    @IdemKey() key?: string,
  ) {
    return this.idem.run(`refund:${u.id}:${id}`, key, body, () =>
      this.orders.requestRefund(u.id, id, body.ticketIds, key as string),
    );
  }

  // ───────────── tickets ─────────────

  @Get('tickets')
  @Route({ summary: 'My tickets with signed QR payloads', roles: BUYER, response: TicketListDto })
  async tickets(@CurrentUser() u: AuthUser): Promise<z.infer<typeof TicketListDto>> {
    const rows = await this.prisma.db.$queryRaw<
      {
        id: string;
        event_id: string;
        title: string;
        starts_at: Date;
        zone_name: string;
        row_label: string | null;
        seat_number: number | null;
        status: string;
        qr_version: number;
      }[]
    >`SELECT t.id, t.event_id, e.title, e.starts_at, z.name AS zone_name, s.row_label, s.seat_number,
             t.status::text AS status, t.qr_version
      FROM tickets t JOIN events e ON e.id = t.event_id JOIN zones z ON z.id = t.zone_id LEFT JOIN seats s ON s.id = t.seat_id
      WHERE t.owner_id = ${u.id}::uuid ORDER BY e.starts_at, t.created_at, t.id LIMIT 500`;
    return {
      items: rows.map((r) => ({
        id: r.id,
        eventId: r.event_id,
        eventTitle: r.title,
        startsAt: r.starts_at.toISOString(),
        zoneName: r.zone_name,
        row: r.row_label,
        number: r.seat_number,
        status: r.status,
        qrVersion: r.qr_version,
        qr: signQr(config.qrSecret, r.id, r.qr_version),
      })),
    };
  }

  /** Transfer to another account by email: the QR version rotates, the old QR stops working. */
  @Post('tickets/:id/transfer')
  @Route({
    summary: 'Transfer a ticket by email (not later than 1 hour before start)',
    roles: BUYER,
    body: TransferSchema,
    response: OkDto,
    status: 201,
    idempotent: true,
  })
  transfer(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
    @ZBody() body: Body<typeof TransferSchema>,
    @IdemKey() key?: string,
  ) {
    return this.idem.run(`transfer:${u.id}:${id}`, key, body, async () => {
      await this.prisma.db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          {
            id: string;
            owner_id: string;
            status: string;
            qr_version: number;
            starts_at: Date;
            event_status: string;
            order_id: string;
            order_status: string;
          }[]
        >`SELECT t.id, t.owner_id, t.status::text AS status, t.qr_version, e.starts_at, e.status::text AS event_status,
                 oi.order_id, o.status::text AS order_status
          FROM tickets t JOIN events e ON e.id = t.event_id JOIN order_items oi ON oi.id = t.order_item_id
          JOIN orders o ON o.id = oi.order_id WHERE t.id = ${id}::uuid FOR UPDATE OF t`;
        const t = rows[0];
        if (!t || t.owner_id !== u.id) throw new AppError('NOT_FOUND', 'Ticket not found');
        if (t.event_status === 'cancelled')
          throw new AppError('EVENT_CANCELLED', 'The event was cancelled');
        if (t.status !== 'valid') throw new AppError('INVALID_STATE', `Ticket is ${t.status}`);
        const now = await dbNow(tx);
        if (now.getTime() > t.starts_at.getTime() - TRANSFER_CUTOFF_MS) {
          throw new AppError(
            'TRANSFER_TOO_LATE',
            'Tickets can be transferred until 1 hour before the start',
          );
        }
        const to = await tx.$queryRaw<{ id: string; role: string; email: string }[]>`
          SELECT id, role::text AS role, email FROM users WHERE lower(email) = lower(${body.toEmail})`;
        if (!to[0] || to[0].role !== 'buyer')
          throw new AppError('NOT_FOUND', 'No buyer account with this email');
        if (to[0].id === u.id)
          throw new AppError('VALIDATION_ERROR', 'You already own this ticket');
        await tx.$executeRaw`UPDATE tickets SET owner_id = ${to[0].id}::uuid, qr_version = qr_version + 1 WHERE id = ${id}::uuid`;
        const tr = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO ticket_transfers (ticket_id, from_user_id, to_user_id, old_qr_version)
          VALUES (${id}::uuid, ${u.id}::uuid, ${to[0].id}::uuid, ${t.qr_version}) RETURNING id`;
        await addHistory(
          tx,
          t.order_id,
          t.order_status,
          t.order_status,
          `user:${u.id}`,
          `ticket ${id} transferred to ${to[0].email}`,
        );
        await queueEmail(
          tx,
          `transfer:${tr[0]!.id}`,
          to[0].email,
          'A ticket was transferred to you',
          `Ticket ${id} is now in your account.`,
        );
      });
      return { ok: true as const };
    });
  }

  // ───────────── virtual queue ─────────────

  @Post('events/:id/queue')
  @HttpCode(200)
  @Route({
    summary: 'Join the virtual queue (one place per account; repeated calls return the same entry)',
    roles: BUYER,
    response: QueueStateDto,
  })
  joinQueue(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    return this.queue.join(id, u.id);
  }

  @Get('events/:id/queue')
  @Route({ summary: 'My queue position and state', roles: BUYER, response: QueueStateDto })
  async queueState(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    await this.queue.tick(id);
    return this.queue.state(id, u.id);
  }

  @Delete('events/:id/queue')
  @Route({ summary: 'Leave the virtual queue', roles: BUYER, response: QueueStateDto })
  leaveQueue(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    return this.queue.leave(id, u.id);
  }

  // ───────────── waitlist ─────────────

  private async waitlistState(
    eventId: string,
    userId: string,
  ): Promise<z.infer<typeof WaitlistDto>> {
    const rows = await this.prisma.db.$queryRaw<{ id: string; status: string; qty: number }[]>`
      SELECT id, status, qty FROM waitlist_entries WHERE event_id = ${eventId}::uuid AND user_id = ${userId}::uuid
      ORDER BY created_at DESC LIMIT 1`;
    if (!rows[0]) throw new AppError('NOT_FOUND', 'You are not on the waitlist for this event');
    const offers = await this.prisma.db.$queryRaw<{ seat_id: number | null; expires_at: Date }[]>`
      SELECT seat_id::float8 AS seat_id, expires_at FROM waitlist_offers
      WHERE entry_id = ${rows[0].id}::uuid AND status = 'offered' AND expires_at > app_now()`;
    return {
      eventId,
      status: rows[0].status as z.infer<typeof WaitlistDto>['status'],
      quantity: rows[0].qty,
      offerExpiresAt: offers[0]?.expires_at.toISOString() ?? null,
      offeredSeatIds: offers.flatMap((o) => (o.seat_id === null ? [] : [o.seat_id])),
    };
  }

  private async runWaitlist(eventId: string): Promise<void> {
    const sink: ChangesByEvent = new Map();
    const res = await this.prisma.db.$transaction((tx) => processWaitlist(tx, eventId), {
      timeout: 30_000,
    });
    pushChanges(sink, eventId, res.changes as SeatChange[]);
    for (const [id, changes] of sink) this.realtime.seatChanges(id, changes);
    for (const o of res.offered)
      this.realtime.toUser(o.userId, 'waitlist:offer', {
        eventId,
        expiresAt: o.expiresAt.toISOString(),
      });
  }

  @Post('events/:id/waitlist')
  @HttpCode(200)
  @Route({
    summary: 'Join the waitlist of a sold-out event (one offer at a time, 30 minutes)',
    roles: BUYER,
    body: WaitlistJoinSchema,
    response: WaitlistDto,
  })
  async joinWaitlist(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
    @ZBody() body: Body<typeof WaitlistJoinSchema>,
  ) {
    const ev = await this.prisma.db.$queryRaw<
      { status: string }[]
    >`SELECT status::text AS status FROM events WHERE id = ${id}::uuid`;
    if (!ev[0] || ev[0].status === 'draft') throw new AppError('NOT_FOUND', 'Event not found');
    if (ev[0].status === 'cancelled')
      throw new AppError('EVENT_CANCELLED', 'The event was cancelled');
    if (ev[0].status !== 'sold_out')
      throw new AppError('INVALID_STATE', 'Seats are still available: book them directly');
    const limit = await this.prisma.db.$queryRaw<
      { per_user_limit: number }[]
    >`SELECT per_user_limit FROM events WHERE id = ${id}::uuid`;
    if (body.quantity > limit[0]!.per_user_limit)
      throw new AppError('VALIDATION_ERROR', 'Quantity exceeds the per-person limit');
    if (body.zoneId) {
      const z = await this.prisma.db.$queryRaw<{ ok: boolean }[]>`
        SELECT true AS ok FROM event_zone_counters WHERE event_id = ${id}::uuid AND zone_id = ${body.zoneId}::uuid`;
      if (!z[0])
        throw new AppError('VALIDATION_ERROR', 'Zone is not a standing zone of this event');
    }
    await this.prisma.db.$executeRaw`
      INSERT INTO waitlist_entries (event_id, user_id, zone_id, qty)
      VALUES (${id}::uuid, ${u.id}::uuid, ${body.zoneId ?? null}::uuid, ${body.quantity})
      ON CONFLICT (event_id, user_id) WHERE status IN ('waiting', 'offered') DO NOTHING`;
    await this.runWaitlist(id);
    return this.waitlistState(id, u.id);
  }

  @Get('events/:id/waitlist')
  @Route({ summary: 'My waitlist entry and current offer', roles: BUYER, response: WaitlistDto })
  myWaitlist(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    return this.waitlistState(id, u.id);
  }

  @Delete('events/:id/waitlist')
  @Route({
    summary: 'Leave the waitlist (an active offer passes to the next person)',
    roles: BUYER,
    response: OkDto,
  })
  async leaveWaitlist(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
  ): Promise<z.infer<typeof OkDto>> {
    await this.prisma.db.$executeRaw`
      UPDATE waitlist_offers SET status = 'cancelled'
      WHERE status = 'offered' AND entry_id IN (SELECT id FROM waitlist_entries WHERE event_id = ${id}::uuid AND user_id = ${u.id}::uuid)`;
    await this.prisma.db.$executeRaw`
      UPDATE waitlist_entries SET status = 'left' WHERE event_id = ${id}::uuid AND user_id = ${u.id}::uuid AND status IN ('waiting', 'offered')`;
    await this.runWaitlist(id);
    return { ok: true };
  }
}
