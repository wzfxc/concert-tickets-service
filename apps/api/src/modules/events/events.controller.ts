import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@tickets/db';
import type { z } from 'zod';
import { EventSearchQuerySchema } from '@tickets/shared';
import { EventDetailDto, EventSearchDto, MapDto } from '../../common/dto.js';
import { dbNow } from '@tickets/domain';
import { AppError } from '@tickets/domain';
import { PrismaService } from '../../common/infra.js';
import type { AuthUser } from '../../common/jwt.js';
import { QueueService } from '../queue/queue.service.js';
import { CurrentUser, Route, UuidParam, ZQuery } from '../../common/route.js';

export type SearchQuery = z.infer<typeof EventSearchQuerySchema>;

const SEAT_STATE = { free: 0, held: 1, sold: 2, blocked: 3, offered: 4 } as const;

interface LayoutCache {
  ids: number[];
  zoneId: string[];
  rows: string[];
  numbers: number[];
  x: number[];
  y: number[];
}
// Venue layouts are immutable once created, so the static part of the map is cached per venue.
const layoutCache = new Map<string, LayoutCache>();

export async function loadLayout(prisma: PrismaService, venueId: string): Promise<LayoutCache> {
  const hit = layoutCache.get(venueId);
  if (hit) return hit;
  const rows = await prisma.db.$queryRaw<
    {
      id: number;
      zone_id: string;
      row_label: string;
      seat_number: number;
      x: number | null;
      y: number | null;
    }[]
  >`SELECT id::float8 AS id, zone_id, row_label, seat_number, x::float8 AS x, y::float8 AS y
    FROM seats WHERE venue_id = ${venueId}::uuid ORDER BY id`;
  const layout: LayoutCache = {
    ids: rows.map((r) => r.id),
    zoneId: rows.map((r) => r.zone_id),
    rows: rows.map((r) => r.row_label),
    numbers: rows.map((r) => r.seat_number),
    x: rows.map((r) => r.x ?? 0),
    y: rows.map((r) => r.y ?? 0),
  };
  if (layoutCache.size > 50) layoutCache.clear();
  layoutCache.set(venueId, layout);
  return layout;
}

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  @Get()
  @Route({
    summary: 'Search events (text, city, date, category, price, has seats; sorted and paged)',
    public: true,
    query: EventSearchQuerySchema,
    response: EventSearchDto,
  })
  async search(@ZQuery() q: SearchQuery): Promise<z.infer<typeof EventSearchDto>> {
    const where: Prisma.Sql[] = [Prisma.sql`e.status IN ('on_sale', 'sold_out', 'rescheduled')`];
    if (q.q)
      where.push(Prisma.sql`(e.title ILIKE ${'%' + q.q + '%'} OR e.city ILIKE ${'%' + q.q + '%'})`);
    if (q.city) where.push(Prisma.sql`e.city ILIKE ${q.city}`);
    if (q.category) where.push(Prisma.sql`e.category = ${q.category}`);
    if (q.dateFrom) where.push(Prisma.sql`e.starts_at >= ${q.dateFrom}::date`);
    if (q.dateTo) where.push(Prisma.sql`e.starts_at < (${q.dateTo}::date + 1)`);
    if (q.priceMin !== undefined) where.push(Prisma.sql`mp.min_price >= ${q.priceMin}`);
    if (q.priceMax !== undefined) where.push(Prisma.sql`mp.min_price <= ${q.priceMax}`);
    if (q.hasSeats === true) where.push(Prisma.sql`e.status <> 'sold_out'`);
    if (q.hasSeats === false) where.push(Prisma.sql`e.status = 'sold_out'`);
    const dir = q.order === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const orderBy =
      q.sort === 'price'
        ? Prisma.sql`mp.min_price ${dir} NULLS LAST`
        : q.sort === 'title'
          ? Prisma.sql`e.title ${dir}`
          : Prisma.sql`e.starts_at ${dir}`;
    const rows = await this.prisma.db.$queryRaw<
      {
        id: string;
        title: string;
        category: string;
        city: string;
        starts_at: Date;
        status: string;
        min_price: number | null;
        total: number;
      }[]
    >(Prisma.sql`
      SELECT e.id, e.title, e.category, e.city, e.starts_at, e.status::text AS status,
             mp.min_price::float8 AS min_price, count(*) OVER ()::int AS total
      FROM events e
      LEFT JOIN LATERAL (SELECT min(price_kop) AS min_price FROM event_zone_prices WHERE event_id = e.id) mp ON true
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY ${orderBy}, e.id
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`);
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        city: r.city,
        startsAt: r.starts_at.toISOString(),
        status: r.status as z.infer<typeof EventDetailDto>['status'],
        minPriceKop: r.min_price,
        hasSeats: r.status !== 'sold_out',
      })),
      total: rows[0]?.total ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** Draft events are visible to their organizer only. */
  private async visibleEvent(id: string, user: AuthUser | undefined) {
    const rows = await this.prisma.db.$queryRaw<
      {
        id: string;
        title: string;
        category: string;
        city: string;
        starts_at: Date;
        ends_at: Date | null;
        status: string;
        sales_start: Date | null;
        per_user_limit: number;
        queue_enabled: boolean;
        queue_latched: boolean;
        rescheduled_at: Date | null;
        venue_id: string;
        organizer_id: string;
      }[]
    >`SELECT id, title, category, city, starts_at, ends_at, status::text AS status, sales_start, per_user_limit,
             queue_enabled, queue_latched, rescheduled_at, venue_id, organizer_id
      FROM events WHERE id = ${id}::uuid`;
    const e = rows[0];
    if (!e || (e.status === 'draft' && e.organizer_id !== user?.id))
      throw new AppError('NOT_FOUND', 'Event not found');
    return e;
  }

  @Get(':id')
  @Route({ summary: 'Event details with zones and prices', response: EventDetailDto })
  async detail(
    @UuidParam('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<z.infer<typeof EventDetailDto>> {
    const e = await this.visibleEvent(id, user);
    const zones = await this.prisma.db.$queryRaw<
      {
        id: string;
        name: string;
        kind: 'seated' | 'dancefloor';
        capacity: number | null;
        price: number | null;
      }[]
    >`SELECT z.id, z.name, z.kind::text AS kind, z.capacity, p.price_kop::float8 AS price
      FROM zones z LEFT JOIN event_zone_prices p ON p.zone_id = z.id AND p.event_id = ${id}::uuid
      WHERE z.venue_id = ${e.venue_id}::uuid ORDER BY z.name`;
    const prices = zones.map((z) => z.price).filter((p): p is number => p !== null);
    return {
      id: e.id,
      title: e.title,
      category: e.category,
      city: e.city,
      startsAt: e.starts_at.toISOString(),
      endsAt: e.ends_at?.toISOString() ?? null,
      status: e.status as z.infer<typeof EventDetailDto>['status'],
      salesStart: e.sales_start?.toISOString() ?? null,
      perUserLimit: e.per_user_limit,
      queueEnabled: e.queue_enabled,
      queueActive: e.queue_enabled || e.queue_latched || (await this.queue.isActive(id)),
      rescheduledAt: e.rescheduled_at?.toISOString() ?? null,
      venueId: e.venue_id,
      organizerId: e.organizer_id,
      minPriceKop: prices.length ? Math.min(...prices) : null,
      hasSeats: e.status !== 'sold_out',
      zones: zones.map((z) => ({
        id: z.id,
        name: z.name,
        kind: z.kind,
        capacity: z.capacity,
        priceKop: z.price,
      })),
      serverNow: (await dbNow(this.prisma.db)).toISOString(),
    };
  }

  @Get(':id/map')
  @Route({
    summary: 'Hall map with live seat states (columnar, one request) and the current event seq',
    response: MapDto,
  })
  async map(
    @UuidParam('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<z.infer<typeof MapDto>> {
    const e = await this.visibleEvent(id, user);
    const db = this.prisma.db;
    // seq first, states second: states are at least as new as `seq`, so replaying later events is idempotent.
    const seqRows = await db.$queryRaw<
      { seq: number }[]
    >`SELECT COALESCE((SELECT last_seq FROM event_seq WHERE event_id = ${id}::uuid), 0)::float8 AS seq`;
    const now = await dbNow(db);
    const [layout, zones, zonePrices, seatPrices, held, sold, blocked, offered, zoneTaken] =
      await Promise.all([
        loadLayout(this.prisma, e.venue_id),
        db.$queryRaw<
          { id: string; name: string; kind: 'seated' | 'dancefloor'; capacity: number | null }[]
        >`
        SELECT id, name, kind::text AS kind, capacity FROM zones WHERE venue_id = ${e.venue_id}::uuid ORDER BY name, id`,
        db.$queryRaw<{ zone_id: string; price: number }[]>`
        SELECT zone_id, price_kop::float8 AS price FROM event_zone_prices WHERE event_id = ${id}::uuid`,
        db.$queryRaw<{ seat_id: number; price: number }[]>`
        SELECT seat_id::float8 AS seat_id, price_kop::float8 AS price FROM event_seat_prices WHERE event_id = ${id}::uuid`,
        db.$queryRaw<{ seat_id: number }[]>`
        SELECT seat_id::float8 AS seat_id FROM seat_holds WHERE event_id = ${id}::uuid AND status = 'held' AND expires_at > ${now}`,
        db.$queryRaw<{ seat_id: number }[]>`
        SELECT seat_id::float8 AS seat_id FROM seat_holds WHERE event_id = ${id}::uuid AND status = 'sold'`,
        db.$queryRaw<
          { seat_id: number }[]
        >`SELECT seat_id::float8 AS seat_id FROM event_blocked_seats WHERE event_id = ${id}::uuid`,
        db.$queryRaw<{ seat_id: number }[]>`
        SELECT seat_id::float8 AS seat_id FROM waitlist_offers
        WHERE event_id = ${id}::uuid AND status = 'offered' AND seat_id IS NOT NULL AND expires_at > ${now}`,
        db.$queryRaw<{ zone_id: string; taken: number; offered: number }[]>`
        SELECT z.zone_id, z.taken::int AS taken, COALESCE(o.q, 0)::int AS offered FROM (
          SELECT zone_id, sum(qty) AS taken FROM zone_holds
          WHERE event_id = ${id}::uuid AND (status = 'sold' OR (status = 'held' AND expires_at > ${now})) GROUP BY zone_id) z
        LEFT JOIN (SELECT o.zone_id, sum(w.qty) AS q FROM waitlist_offers o JOIN waitlist_entries w ON w.id = o.entry_id
                   WHERE o.event_id = ${id}::uuid AND o.status = 'offered' AND o.expires_at > ${now} AND o.zone_id IS NOT NULL
                   GROUP BY o.zone_id) o ON o.zone_id = z.zone_id`,
      ]);
    const priceOfZone = new Map(zonePrices.map((p) => [p.zone_id, p.price]));
    const priceOfSeat = new Map(seatPrices.map((p) => [p.seat_id, p.price]));
    const stateOf = new Map<number, number>();
    for (const r of offered) stateOf.set(r.seat_id, SEAT_STATE.offered);
    for (const r of held) stateOf.set(r.seat_id, SEAT_STATE.held);
    for (const r of sold) stateOf.set(r.seat_id, SEAT_STATE.sold);
    for (const r of blocked) stateOf.set(r.seat_id, SEAT_STATE.blocked);
    const zoneIdx = new Map(zones.map((z, i) => [z.id, i]));
    const takenBy = new Map<string, number>();
    const state = layout.ids.map((sid, i) => {
      const s = stateOf.get(sid) ?? SEAT_STATE.free;
      const zid = layout.zoneId[i]!;
      // A seat in a zone that has no price (and no per-seat price) is not for sale.
      const sellable = priceOfSeat.has(sid) || priceOfZone.has(zid);
      const out = sellable ? s : SEAT_STATE.blocked;
      if (out !== SEAT_STATE.free) takenBy.set(zid, (takenBy.get(zid) ?? 0) + 1);
      return out;
    });
    const dance = new Map(zoneTaken.map((z) => [z.zone_id, z]));
    return {
      eventId: id,
      seq: seqRows[0]!.seq,
      serverNow: now.toISOString(),
      zones: zones.map((z) => ({
        id: z.id,
        name: z.name,
        kind: z.kind,
        capacity: z.capacity,
        priceKop: priceOfZone.get(z.id) ?? null,
        taken: z.kind === 'dancefloor' ? (dance.get(z.id)?.taken ?? 0) : (takenBy.get(z.id) ?? 0),
        offered: z.kind === 'dancefloor' ? (dance.get(z.id)?.offered ?? 0) : 0,
      })),
      seats: {
        ids: layout.ids,
        zoneIdx: layout.zoneId.map((zid) => zoneIdx.get(zid) ?? 0),
        rows: layout.rows,
        numbers: layout.numbers,
        x: layout.x,
        y: layout.y,
        state,
        priceKop: layout.ids.map(
          (sid, i) => priceOfSeat.get(sid) ?? priceOfZone.get(layout.zoneId[i]!) ?? 0,
        ),
      },
    };
  }
}
