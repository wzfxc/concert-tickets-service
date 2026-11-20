import { Controller, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  AssignControllerSchema,
  CreateEventSchema,
  CreatePromoSchema,
  PriceAssignmentSchema,
  RescheduleEventSchema,
  SalesReportQuerySchema,
  UpdateEventSettingsSchema,
  VenueLayoutSchema,
} from '@tickets/shared';
import {
  CancelProgressDto,
  OkDto,
  OrganizerEventDto,
  OrganizerEventListDto,
  PromoDto,
  PromoListDto,
  SalesReportDto,
  VenueDto,
  VenueListDto,
} from './dto.js';
import { dbNow } from './domain/common.js';
import { releaseOrder, type ChangesByEvent } from './domain/lifecycle.js';
import { AppError } from './errors.js';
import { PrismaService, RealtimeService } from './infra.js';
import type { AuthUser } from './jwt.js';
import { CurrentUser, Route, UuidParam, ZBody, ZQuery } from './route.js';

const ORG = ['organizer'] as const;
const MAX_VENUE_SEATS = 50_000;
const TX = { maxWait: 60_000, timeout: 180_000 } as const;
type Body<T extends z.ZodTypeAny> = z.infer<T>;
type EventDto = z.infer<typeof OrganizerEventDto>;

interface EventRow {
  id: string;
  title: string;
  category: string;
  city: string;
  starts_at: Date;
  status: string;
  venue_id: string;
  sales_start: Date | null;
  per_user_limit: number;
  queue_enabled: boolean;
  min_price: number | null;
}

const EVENT_SELECT = `e.id, e.title, e.category, e.city, e.starts_at, e.status::text AS status, e.venue_id, e.sales_start,
  e.per_user_limit, e.queue_enabled,
  (SELECT min(price_kop) FROM event_zone_prices WHERE event_id = e.id)::float8 AS min_price`;

const toEventDto = (e: EventRow): EventDto => ({
  id: e.id,
  title: e.title,
  category: e.category,
  city: e.city,
  startsAt: e.starts_at.toISOString(),
  status: e.status as EventDto['status'],
  minPriceKop: e.min_price,
  hasSeats: e.status !== 'sold_out',
  venueId: e.venue_id,
  salesStart: e.sales_start?.toISOString() ?? null,
  perUserLimit: e.per_user_limit,
  queueEnabled: e.queue_enabled,
});

@ApiTags('organizer')
@Controller()
export class OrganizerController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Ownership check: someone else's (or unknown) event is "not found" so existence is not leaked. */
  private async ownEvent(
    eventId: string,
    userId: string,
  ): Promise<EventRow & { organizer_id: string }> {
    const rows = await this.prisma.db.$queryRawUnsafe<(EventRow & { organizer_id: string })[]>(
      `SELECT ${EVENT_SELECT}, e.organizer_id FROM events e WHERE e.id = $1::uuid`,
      eventId,
    );
    if (!rows[0] || rows[0].organizer_id !== userId)
      throw new AppError('NOT_FOUND', 'Event not found');
    return rows[0];
  }

  private async eventDto(eventId: string): Promise<EventDto> {
    const rows = await this.prisma.db.$queryRawUnsafe<EventRow[]>(
      `SELECT ${EVENT_SELECT} FROM events e WHERE e.id = $1::uuid`,
      eventId,
    );
    return toEventDto(rows[0]!);
  }

  // ───────────── venues ─────────────

  private async venueDto(venueId: string): Promise<z.infer<typeof VenueDto>> {
    const db = this.prisma.db;
    const v = await db.$queryRaw<
      { id: string; name: string; city: string }[]
    >`SELECT id, name, city FROM venues WHERE id = ${venueId}::uuid`;
    const zones = await db.$queryRaw<
      { id: string; name: string; kind: 'seated' | 'dancefloor'; capacity: number | null }[]
    >`
      SELECT id, name, kind::text AS kind, capacity FROM zones WHERE venue_id = ${venueId}::uuid ORDER BY name, id`;
    const seats = await db.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM seats WHERE venue_id = ${venueId}::uuid`;
    return { id: v[0]!.id, name: v[0]!.name, city: v[0]!.city, seatCount: seats[0]!.n, zones };
  }

  @Post('venues')
  @Route({
    summary: 'Upload a venue layout (JSON: zones, rows, seats, dancefloor capacity)',
    roles: ORG,
    body: VenueLayoutSchema,
    response: VenueDto,
    status: 201,
  })
  async createVenue(@CurrentUser() u: AuthUser, @ZBody() layout: Body<typeof VenueLayoutSchema>) {
    const seatTotal = layout.zones.reduce(
      (n, z) => n + (z.kind === 'seated' ? z.rows.reduce((a, r) => a + r.seats, 0) : 0),
      0,
    );
    if (seatTotal > MAX_VENUE_SEATS)
      throw new AppError('VALIDATION_ERROR', `A venue can have at most ${MAX_VENUE_SEATS} seats`);
    const id = await this.prisma.db.$transaction(async (tx) => {
      const v = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO venues (organizer_id, name, city, layout)
        VALUES (${u.id}::uuid, ${layout.name}, ${layout.city}, ${JSON.stringify(layout)}::jsonb) RETURNING id`;
      const venueId = v[0]!.id;
      let yOffset = 0;
      for (const zone of layout.zones) {
        const capacity = zone.kind === 'dancefloor' ? zone.capacity : null;
        const z = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO zones (venue_id, name, kind, capacity)
          VALUES (${venueId}::uuid, ${zone.name}, ${zone.kind}::zone_kind, ${capacity}::int) RETURNING id`;
        if (zone.kind === 'seated') {
          const labels: string[] = [];
          const numbers: number[] = [];
          const xs: number[] = [];
          const ys: number[] = [];
          zone.rows.forEach((row, ri) => {
            for (let i = 0; i < row.seats; i++) {
              labels.push(row.label);
              numbers.push(i + 1);
              xs.push((row.x ?? 0) + i);
              ys.push(row.y ?? yOffset + ri);
            }
          });
          yOffset += zone.rows.length + 2;
          for (let from = 0; from < labels.length; from += 10_000) {
            const to = from + 10_000;
            await tx.$executeRaw`
              INSERT INTO seats (venue_id, zone_id, row_label, seat_number, x, y)
              SELECT ${venueId}::uuid, ${z[0]!.id}::uuid, l, n, x, y
              FROM unnest(${labels.slice(from, to)}::text[], ${numbers.slice(from, to)}::int[],
                          ${xs.slice(from, to)}::real[], ${ys.slice(from, to)}::real[]) AS t(l, n, x, y)`;
          }
        }
      }
      return venueId;
    }, TX);
    return this.venueDto(id);
  }

  @Get('venues')
  @Route({ summary: 'My venues', roles: ORG, response: VenueListDto })
  async venues(@CurrentUser() u: AuthUser): Promise<z.infer<typeof VenueListDto>> {
    const ids = await this.prisma.db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM venues WHERE organizer_id = ${u.id}::uuid ORDER BY created_at DESC`;
    return { items: await Promise.all(ids.map((r) => this.venueDto(r.id))) };
  }

  @Get('venues/:id')
  @Route({ summary: 'One of my venues (zones and seat count)', roles: ORG, response: VenueDto })
  async venue(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    const own = await this.prisma.db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM venues WHERE id = ${id}::uuid AND organizer_id = ${u.id}::uuid`;
    if (!own[0]) throw new AppError('NOT_FOUND', 'Venue not found');
    return this.venueDto(id);
  }

  // ───────────── events ─────────────

  @Post('events')
  @Route({
    summary: 'Create an event (draft)',
    roles: ORG,
    body: CreateEventSchema,
    response: OrganizerEventDto,
    status: 201,
  })
  async createEvent(@CurrentUser() u: AuthUser, @ZBody() b: Body<typeof CreateEventSchema>) {
    const v = await this.prisma.db.$queryRaw<{ city: string }[]>`
      SELECT city FROM venues WHERE id = ${b.venueId}::uuid AND organizer_id = ${u.id}::uuid`;
    if (!v[0]) throw new AppError('NOT_FOUND', 'Venue not found');
    const rows = await this.prisma.db.$queryRaw<{ id: string }[]>`
      INSERT INTO events (organizer_id, venue_id, title, category, city, starts_at, ends_at, sales_start, per_user_limit)
      VALUES (${u.id}::uuid, ${b.venueId}::uuid, ${b.title}, ${b.category}, ${v[0].city}, ${new Date(b.startsAt)},
              ${b.endsAt ? new Date(b.endsAt) : null}, ${b.salesStart ? new Date(b.salesStart) : null}, ${b.perUserLimit})
      RETURNING id`;
    return this.eventDto(rows[0]!.id);
  }

  @Get('organizer/events')
  @Route({ summary: 'My events (all statuses)', roles: ORG, response: OrganizerEventListDto })
  async myEvents(@CurrentUser() u: AuthUser): Promise<z.infer<typeof OrganizerEventListDto>> {
    const rows = await this.prisma.db.$queryRawUnsafe<EventRow[]>(
      `SELECT ${EVENT_SELECT} FROM events e WHERE e.organizer_id = $1::uuid ORDER BY e.starts_at DESC LIMIT 500`,
      u.id,
    );
    return { items: rows.map(toEventDto) };
  }

  @Put('events/:id/prices')
  @Route({
    summary: 'Assign zone/seat prices and block seats that are not for sale',
    roles: ORG,
    body: PriceAssignmentSchema,
    response: OkDto,
  })
  async setPrices(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
    @ZBody() b: Body<typeof PriceAssignmentSchema>,
  ) {
    const ev = await this.ownEvent(id, u.id);
    if (!['draft', 'on_sale', 'sold_out', 'rescheduled'].includes(ev.status))
      throw new AppError('INVALID_STATE', `Event is ${ev.status}`);
    await this.prisma.db.$transaction(async (tx) => {
      for (const zp of b.zonePrices) {
        const n = await tx.$executeRaw`
          INSERT INTO event_zone_prices (event_id, zone_id, price_kop)
          SELECT ${id}::uuid, z.id, ${zp.priceKop}::bigint FROM zones z WHERE z.id = ${zp.zoneId}::uuid AND z.venue_id = ${ev.venue_id}::uuid
          ON CONFLICT (event_id, zone_id) DO UPDATE SET price_kop = EXCLUDED.price_kop`;
        if (n === 0)
          throw new AppError('VALIDATION_ERROR', 'Zone does not belong to the venue', {
            zoneId: zp.zoneId,
          });
      }
      for (const sp of b.seatPrices) {
        const n = await tx.$executeRaw`
          INSERT INTO event_seat_prices (event_id, seat_id, price_kop)
          SELECT ${id}::uuid, s.id, ${sp.priceKop}::bigint FROM seats s WHERE s.id = ANY (${sp.seatIds}::bigint[]) AND s.venue_id = ${ev.venue_id}::uuid
          ON CONFLICT (event_id, seat_id) DO UPDATE SET price_kop = EXCLUDED.price_kop`;
        if (n !== sp.seatIds.length)
          throw new AppError('VALIDATION_ERROR', 'Some seats do not belong to the venue');
      }
      if (b.blockedSeatIds.length) {
        const own = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM seats WHERE id = ANY (${b.blockedSeatIds}::bigint[]) AND venue_id = ${ev.venue_id}::uuid`;
        if (own[0]!.n !== new Set(b.blockedSeatIds).size)
          throw new AppError('VALIDATION_ERROR', 'Some seats do not belong to the venue');
        const taken = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM seat_holds WHERE event_id = ${id}::uuid AND seat_id = ANY (${b.blockedSeatIds}::bigint[])
            AND status IN ('held', 'sold')`;
        if (taken[0]!.n > 0)
          throw new AppError('SEATS_UNAVAILABLE', 'Some of these seats are already held or sold');
        await tx.$executeRaw`
          INSERT INTO event_blocked_seats (event_id, seat_id)
          SELECT ${id}::uuid, s FROM unnest(${b.blockedSeatIds}::bigint[]) AS s ON CONFLICT DO NOTHING`;
      }
    }, TX);
    return { ok: true as const };
  }

  @Post('events/:id/publish')
  @HttpCode(200)
  @Route({
    summary: 'Publish a draft event (starts selling at sales_start)',
    roles: ORG,
    response: OrganizerEventDto,
  })
  async publish(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    const ev = await this.ownEvent(id, u.id);
    if (ev.status !== 'draft') throw new AppError('INVALID_STATE', `Event is ${ev.status}`);
    await this.prisma.db.$transaction(async (tx) => {
      const priced = await tx.$queryRaw<{ n: number }[]>`
        SELECT ((SELECT count(*) FROM event_zone_prices WHERE event_id = ${id}::uuid)
              + (SELECT count(*) FROM event_seat_prices WHERE event_id = ${id}::uuid))::int AS n`;
      if (priced[0]!.n === 0)
        throw new AppError('VALIDATION_ERROR', 'Assign prices before publishing');
      await tx.$executeRaw`
        INSERT INTO event_zone_counters (event_id, zone_id, capacity)
        SELECT ${id}::uuid, z.id, z.capacity FROM zones z JOIN event_zone_prices p ON p.zone_id = z.id AND p.event_id = ${id}::uuid
        WHERE z.venue_id = ${ev.venue_id}::uuid AND z.kind = 'dancefloor' ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO event_seq (event_id, last_seq) VALUES (${id}::uuid, 0) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`UPDATE events SET status = 'on_sale' WHERE id = ${id}::uuid`;
    });
    return this.eventDto(id);
  }

  @Patch('events/:id/settings')
  @Route({
    summary: 'Change per-person limit, queue flag, sales start',
    roles: ORG,
    body: UpdateEventSettingsSchema,
    response: OrganizerEventDto,
  })
  async settings(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
    @ZBody() b: Body<typeof UpdateEventSettingsSchema>,
  ) {
    await this.ownEvent(id, u.id);
    await this.prisma.db.$executeRaw`
      UPDATE events SET
        per_user_limit = COALESCE(${b.perUserLimit ?? null}::int, per_user_limit),
        queue_enabled = COALESCE(${b.queueEnabled ?? null}::boolean, queue_enabled),
        sales_start = CASE WHEN ${b.salesStart !== undefined} THEN ${b.salesStart ? new Date(b.salesStart) : null}::timestamptz ELSE sales_start END
      WHERE id = ${id}::uuid`;
    return this.eventDto(id);
  }

  @Post('events/:id/controllers')
  @HttpCode(200)
  @Route({
    summary: 'Assign a gate controller to my event',
    roles: ORG,
    body: AssignControllerSchema,
    response: OkDto,
  })
  async assignController(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
    @ZBody() b: Body<typeof AssignControllerSchema>,
  ) {
    await this.ownEvent(id, u.id);
    const n = await this.prisma.db.$executeRaw`
      INSERT INTO event_controllers (event_id, user_id)
      SELECT ${id}::uuid, id FROM users WHERE lower(email) = lower(${b.email}) AND role = 'controller' ON CONFLICT DO NOTHING`;
    const exists = await this.prisma.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM event_controllers c JOIN users x ON x.id = c.user_id
      WHERE c.event_id = ${id}::uuid AND lower(x.email) = lower(${b.email})`;
    if (n === 0 && exists[0]!.n === 0)
      throw new AppError('NOT_FOUND', 'No controller account with this email');
    return { ok: true as const };
  }

  @Post('events/:id/reschedule')
  @HttpCode(200)
  @Route({
    summary: 'Reschedule the event (buyers are e-mailed; 14-day full-refund window starts)',
    roles: ORG,
    body: RescheduleEventSchema,
    response: OrganizerEventDto,
  })
  async reschedule(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
    @ZBody() b: Body<typeof RescheduleEventSchema>,
  ) {
    const ev = await this.ownEvent(id, u.id);
    if (!['on_sale', 'sold_out', 'rescheduled'].includes(ev.status))
      throw new AppError('INVALID_STATE', `Event is ${ev.status}`);
    const startsAt = new Date(b.startsAt);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE events SET starts_at = ${startsAt}, ends_at = ${b.endsAt ? new Date(b.endsAt) : null},
          status = CASE WHEN status = 'sold_out' THEN status ELSE 'rescheduled'::event_status END, rescheduled_at = app_now()
        WHERE id = ${id}::uuid`;
      await tx.$executeRaw`
        INSERT INTO email_outbox (dedup_key, to_email, subject, body)
        SELECT 'reschedule:' || ${id} || ':' || o.id || ':' || ${startsAt.toISOString()}, usr.email, 'Event rescheduled',
               'The event "' || ${ev.title} || '" moved to ' || ${startsAt.toISOString()} || '. You can return tickets for 14 days.'
        FROM orders o JOIN users usr ON usr.id = o.user_id
        WHERE o.event_id = ${id}::uuid AND o.status IN ('paid', 'partially_refunded') ON CONFLICT (dedup_key) DO NOTHING`;
    });
    this.realtime.seatChanges(id, []);
    return this.eventDto(id);
  }

  // ───────────── mass cancel ─────────────

  private async progress(eventId: string): Promise<z.infer<typeof CancelProgressDto>> {
    const rows = await this.prisma.db.$queryRaw<
      { status: string; total: number; done: number; started_at: Date; finished_at: Date | null }[]
    >`
      SELECT status, total, done, started_at, finished_at FROM cancel_batches WHERE event_id = ${eventId}::uuid`;
    const r = rows[0];
    return {
      eventId,
      status: (r?.status ?? 'none') as 'none' | 'running' | 'done',
      total: r?.total ?? 0,
      done: r?.done ?? 0,
      startedAt: r?.started_at.toISOString() ?? null,
      finishedAt: r?.finished_at?.toISOString() ?? null,
    };
  }

  /**
   * Stops sales and transfers immediately (status flips inside one transaction), then registers one refund per
   * paid order (unique key `cancel:<orderId>`). Sending the refunds is the worker's job; calling cancel again is a no-op.
   */
  @Post('events/:id/cancel')
  @HttpCode(200)
  @Route({
    summary: 'Cancel the event: sales stop at once, every paid order is refunded in the background',
    roles: ORG,
    response: CancelProgressDto,
  })
  async cancel(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    await this.ownEvent(id, u.id);
    const sink: ChangesByEvent = new Map();
    await this.prisma.db.$transaction(async (tx) => {
      const ev = await tx.$queryRaw<
        { status: string }[]
      >`SELECT status::text AS status FROM events WHERE id = ${id}::uuid FOR UPDATE`;
      if (ev[0]!.status === 'cancelled') return;
      if (['draft', 'finished', 'paid_out'].includes(ev[0]!.status))
        throw new AppError('INVALID_STATE', `Event is ${ev[0]!.status}`);
      await tx.$executeRaw`UPDATE events SET status = 'cancelled', cancelled_at = app_now() WHERE id = ${id}::uuid`;
      const unpaid = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE event_id = ${id}::uuid AND status IN ('holding', 'awaiting_payment') FOR UPDATE`;
      for (const o of unpaid)
        await releaseOrder(tx, o.id, `organizer:${u.id}`, 'event cancelled', sink, new Set());
      await tx.$executeRaw`UPDATE tickets SET status = 'cancelled' WHERE event_id = ${id}::uuid AND status = 'valid'`;
      const created = await tx.$queryRaw<{ order_id: string }[]>`
        INSERT INTO refunds (order_id, payment_id, amount_kop, fee_kop, kind, idempotency_key, reason)
        SELECT o.id,
               (SELECT p.id FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded' ORDER BY p.created_at LIMIT 1),
               LEAST(x.amount, o.paid_kop - o.refunded_kop), LEAST(x.fee, x.amount, o.paid_kop - o.refunded_kop),
               'cancellation', 'cancel:' || o.id, 'event cancelled'
        FROM orders o
        JOIN LATERAL (SELECT COALESCE(sum(price_kop - discount_kop + fee_kop), 0) AS amount, COALESCE(sum(fee_kop), 0) AS fee
                      FROM order_items WHERE order_id = o.id AND NOT refunded) x ON true
        WHERE o.event_id = ${id}::uuid AND o.status IN ('paid', 'partially_refunded')
          AND LEAST(x.amount, o.paid_kop - o.refunded_kop) > 0
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.idempotency_key = 'cancel:' || o.id)
        RETURNING order_id`;
      const ids = created.map((c) => c.order_id);
      if (ids.length) {
        await tx.$executeRaw`
          INSERT INTO order_history (order_id, from_status, to_status, actor, note)
          SELECT id, status, 'refunded', ${'organizer:' + u.id}, 'event cancelled: refund registered' FROM orders WHERE id = ANY (${ids}::uuid[])`;
        await tx.$executeRaw`UPDATE order_items SET refunded = true WHERE order_id = ANY (${ids}::uuid[])`;
        await tx.$executeRaw`UPDATE orders SET status = 'refunded' WHERE id = ANY (${ids}::uuid[])`;
        await tx.$executeRaw`
          INSERT INTO email_outbox (dedup_key, to_email, subject, body)
          SELECT 'cancel:' || o.id, usr.email, 'Event cancelled', 'The event was cancelled. Your order ' || o.id || ' is being refunded in full.'
          FROM orders o JOIN users usr ON usr.id = o.user_id WHERE o.id = ANY (${ids}::uuid[]) ON CONFLICT (dedup_key) DO NOTHING`;
      }
      await tx.$executeRaw`
        INSERT INTO cancel_batches (event_id, total, done, status, finished_at)
        VALUES (${id}::uuid, ${ids.length}, 0, ${ids.length === 0 ? 'done' : 'running'}, ${ids.length === 0 ? new Date() : null})
        ON CONFLICT (event_id) DO NOTHING`;
      await tx.$executeRaw`UPDATE waitlist_offers SET status = 'cancelled' WHERE event_id = ${id}::uuid AND status = 'offered'`;
      await tx.$executeRaw`UPDATE waitlist_entries SET status = 'left' WHERE event_id = ${id}::uuid AND status IN ('waiting', 'offered')`;
      await tx.$executeRaw`UPDATE queue_entries SET status = 'left' WHERE event_id = ${id}::uuid AND status IN ('waiting', 'admitted')`;
    }, TX);
    for (const [eventId, changes] of sink) this.realtime.seatChanges(eventId, changes);
    this.realtime.eventStatus(id, 'cancelled');
    const progress = await this.progress(id);
    this.realtime.cancelProgress(id, progress);
    return progress;
  }

  @Get('events/:id/cancel-progress')
  @Route({
    summary: 'Mass-cancel progress (also pushed live over Socket.IO room cancel:{eventId})',
    roles: ORG,
    response: CancelProgressDto,
  })
  async cancelProgress(@CurrentUser() u: AuthUser, @UuidParam('id') id: string) {
    await this.ownEvent(id, u.id);
    return this.progress(id);
  }

  // ───────────── promo codes ─────────────

  private async promoDto(promoId: string): Promise<z.infer<typeof PromoDto>> {
    const r = await this.prisma.db.$queryRaw<
      {
        id: string;
        event_id: string | null;
        code: string;
        kind: 'percent' | 'fixed';
        value: number;
        usage_limit: number;
        used: number;
        valid_until: Date | null;
      }[]
    >`SELECT id, event_id, code, kind, value::float8 AS value, usage_limit, used, valid_until FROM promo_codes WHERE id = ${promoId}::uuid`;
    const p = r[0]!;
    return {
      id: p.id,
      eventId: p.event_id,
      code: p.code,
      kind: p.kind,
      value: p.value,
      usageLimit: p.usage_limit,
      used: p.used,
      validUntil: p.valid_until?.toISOString() ?? null,
    };
  }

  @Post('promos')
  @Route({
    summary: 'Create a promo code for one of my events',
    roles: ORG,
    body: CreatePromoSchema,
    response: PromoDto,
    status: 201,
  })
  async createPromo(@CurrentUser() u: AuthUser, @ZBody() b: Body<typeof CreatePromoSchema>) {
    if (!b.eventId) throw new AppError('VALIDATION_ERROR', 'eventId is required');
    await this.ownEvent(b.eventId, u.id);
    const rows = await this.prisma.db.$queryRaw<{ id: string }[]>`
      INSERT INTO promo_codes (event_id, code, kind, value, usage_limit, valid_until)
      VALUES (${b.eventId}::uuid, ${b.code}, ${b.kind}, ${b.value}::bigint, ${b.usageLimit}, ${b.validUntil ? new Date(b.validUntil) : null})
      ON CONFLICT (event_id, upper(code)) DO NOTHING RETURNING id`;
    if (!rows[0]) throw new AppError('CONFLICT', 'This promo code already exists for the event');
    return this.promoDto(rows[0].id);
  }

  @Get('events/:id/promos')
  @Route({
    summary: 'Promo codes of my event with usage counters',
    roles: ORG,
    response: PromoListDto,
  })
  async promos(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
  ): Promise<z.infer<typeof PromoListDto>> {
    await this.ownEvent(id, u.id);
    const ids = await this.prisma.db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM promo_codes WHERE event_id = ${id}::uuid ORDER BY created_at`;
    return { items: await Promise.all(ids.map((r) => this.promoDto(r.id))) };
  }

  // ───────────── sales ─────────────

  @Get('organizer/events/:id/sales')
  @Route({
    summary:
      'Sales by hour and zone, fill rate, queue → payment funnel (aggregates only, no buyer data)',
    roles: ORG,
    query: SalesReportQuerySchema,
    response: SalesReportDto,
  })
  async sales(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
    @ZQuery() q: Body<typeof SalesReportQuerySchema>,
  ) {
    const ev = await this.ownEvent(id, u.id);
    const db = this.prisma.db;
    const now = await dbNow(db);
    const to = q.to ? new Date(`${q.to}T00:00:00Z`) : now;
    const from = q.from
      ? new Date(`${q.from}T00:00:00Z`)
      : new Date(to.getTime() - 90 * 86_400_000);
    const [hourly, byZone, totals, cap, funnel] = await Promise.all([
      db.$queryRaw<{ hour: Date; tickets: number; revenue: number }[]>`
        SELECT date_trunc('hour', o.paid_at) AS hour, count(*)::int AS tickets, sum(oi.price_kop - oi.discount_kop)::float8 AS revenue
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.event_id = ${id}::uuid AND o.status IN ('paid', 'partially_refunded', 'refunded') AND o.paid_at >= ${from} AND o.paid_at < ${to}
        GROUP BY 1 ORDER BY 1`,
      db.$queryRaw<{ zone_id: string; name: string; tickets: number; revenue: number }[]>`
        SELECT z.id AS zone_id, z.name, count(*)::int AS tickets, sum(oi.price_kop - oi.discount_kop)::float8 AS revenue
        FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN zones z ON z.id = oi.zone_id
        WHERE o.event_id = ${id}::uuid AND o.status IN ('paid', 'partially_refunded', 'refunded') AND o.paid_at >= ${from} AND o.paid_at < ${to}
        GROUP BY z.id, z.name ORDER BY z.name`,
      db.$queryRaw<{ tickets: number; revenue: number }[]>`
        SELECT count(*)::int AS tickets, COALESCE(sum(oi.price_kop - oi.discount_kop), 0)::float8 AS revenue
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.event_id = ${id}::uuid AND o.status IN ('paid', 'partially_refunded', 'refunded') AND o.paid_at >= ${from} AND o.paid_at < ${to}`,
      db.$queryRaw<{ capacity: number; sold: number }[]>`
        SELECT ((SELECT count(*) FROM seats WHERE venue_id = ${ev.venue_id}::uuid)
              + (SELECT COALESCE(sum(capacity), 0) FROM event_zone_counters WHERE event_id = ${id}::uuid)
              - (SELECT count(*) FROM event_blocked_seats WHERE event_id = ${id}::uuid))::int AS capacity,
               (SELECT count(*) FROM tickets WHERE event_id = ${id}::uuid AND status IN ('valid', 'used'))::int AS sold`,
      db.$queryRaw<
        { joined: number; admitted: number; created: number; paid: number; qpaid: number }[]
      >`
        SELECT (SELECT count(*) FROM queue_entries WHERE event_id = ${id}::uuid)::int AS joined,
               (SELECT count(*) FROM queue_entries WHERE event_id = ${id}::uuid AND admitted_at IS NOT NULL)::int AS admitted,
               (SELECT count(*) FROM orders WHERE event_id = ${id}::uuid)::int AS created,
               (SELECT count(*) FROM orders WHERE event_id = ${id}::uuid AND status IN ('paid', 'partially_refunded', 'refunded'))::int AS paid,
               (SELECT count(*) FROM orders o WHERE o.event_id = ${id}::uuid AND o.status IN ('paid', 'partially_refunded', 'refunded')
                  AND EXISTS (SELECT 1 FROM queue_entries q WHERE q.event_id = o.event_id AND q.user_id = o.user_id AND q.admitted_at IS NOT NULL))::int AS qpaid`,
    ]);
    const capacity = cap[0]!.capacity;
    return {
      eventId: id,
      from: from.toISOString(),
      to: to.toISOString(),
      ticketsSold: totals[0]!.tickets,
      revenueKop: totals[0]!.revenue,
      capacity,
      fillRate: capacity > 0 ? cap[0]!.sold / capacity : 0,
      hourly: hourly.map((h) => ({
        hour: h.hour.toISOString(),
        tickets: h.tickets,
        revenueKop: h.revenue,
      })),
      byZone: byZone.map((z) => ({
        zoneId: z.zone_id,
        zoneName: z.name,
        tickets: z.tickets,
        revenueKop: z.revenue,
      })),
      funnel: {
        queueJoined: funnel[0]!.joined,
        queueAdmitted: funnel[0]!.admitted,
        ordersCreated: funnel[0]!.created,
        ordersPaid: funnel[0]!.paid,
        queueToPaid: funnel[0]!.qpaid,
      },
    };
  }
}
