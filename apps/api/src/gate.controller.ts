import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { ScanSchema, type ErrorCode } from '@tickets/shared';
import { verifyQr } from '@tickets/shared/qr';
import { config } from './config.js';
import { addHistory } from './domain/common.js';
import { GateStatsDto, ScanOkDto } from './dto.js';
import { AppError } from './errors.js';
import { PrismaService } from './infra.js';
import type { AuthUser } from './jwt.js';
import { CurrentUser, Route, UuidParam, ZBody } from './route.js';

interface TicketRow {
  id: string;
  event_id: string;
  status: string;
  qr_version: number;
  used_at: Date | null;
  used_gate: string | null;
  zone_name: string;
  row_label: string | null;
  seat_number: number | null;
  order_id: string;
  order_status: string;
}

const TICKET_SQL = `
  SELECT t.id, t.event_id, t.status::text AS status, t.qr_version, t.used_at, t.used_gate, z.name AS zone_name,
         s.row_label, s.seat_number, oi.order_id, o.status::text AS order_status
  FROM tickets t JOIN zones z ON z.id = t.zone_id LEFT JOIN seats s ON s.id = t.seat_id
  JOIN order_items oi ON oi.id = t.order_item_id JOIN orders o ON o.id = oi.order_id`;

@ApiTags('gate')
@Controller()
export class GateController {
  constructor(private readonly prisma: PrismaService) {}

  /** Controllers work only with events they are assigned to; organizers may view counters of their own events. */
  private async assertGateAccess(
    eventId: string,
    user: AuthUser,
    allowOrganizer: boolean,
  ): Promise<void> {
    const db = this.prisma.db;
    if (user.role === 'controller') {
      const r = await db.$queryRaw<{ ok: boolean }[]>`
        SELECT true AS ok FROM event_controllers WHERE event_id = ${eventId}::uuid AND user_id = ${user.id}::uuid`;
      if (r[0]) return;
    } else if (allowOrganizer && user.role === 'organizer') {
      const r = await db.$queryRaw<{ ok: boolean }[]>`
        SELECT true AS ok FROM events WHERE id = ${eventId}::uuid AND organizer_id = ${user.id}::uuid`;
      if (r[0]) return;
    }
    throw new AppError('FORBIDDEN', 'You are not assigned to this event');
  }

  private async counts(eventId: string): Promise<{ admitted: number; remaining: number }> {
    const r = await this.prisma.db.$queryRaw<{ admitted: number; remaining: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'used')::int AS admitted, count(*) FILTER (WHERE status = 'valid')::int AS remaining
      FROM tickets WHERE event_id = ${eventId}::uuid AND status IN ('used', 'valid')`;
    return r[0] ?? { admitted: 0, remaining: 0 };
  }

  /** Records the refusal (audit trail of scans) and raises the coded error shown to the controller. */
  private async reject(
    code: ErrorCode,
    scan: { eventId: string; gate: string; scannerId: string; ticket?: TicketRow | null },
    message: string,
    details?: Record<string, unknown>,
  ): Promise<never> {
    await this.prisma.db.$executeRaw`
      INSERT INTO entrance_scans (ticket_id, event_id, gate, scanner_id, result)
      VALUES (${scan.ticket?.id ?? null}::uuid, ${scan.eventId}::uuid, ${scan.gate}, ${scan.scannerId}::uuid, ${code})`;
    throw new AppError(code, message, details);
  }

  @Post('scan')
  @HttpCode(200)
  @Route({
    summary: 'Scan a QR code at the gate (atomic admission, coded refusal reasons)',
    roles: ['controller'],
    body: ScanSchema,
    response: ScanOkDto,
  })
  async scan(
    @CurrentUser() u: AuthUser,
    @ZBody() b: z.infer<typeof ScanSchema>,
  ): Promise<z.infer<typeof ScanOkDto>> {
    await this.assertGateAccess(b.eventId, u, false);
    const db = this.prisma.db;
    const ctx = { eventId: b.eventId, gate: b.gate, scannerId: u.id };
    const evs = await db.$queryRaw<
      { status: string }[]
    >`SELECT status::text AS status FROM events WHERE id = ${b.eventId}::uuid`;
    if (evs[0]?.status === 'cancelled')
      return this.reject('EVENT_CANCELLED', ctx, 'The event was cancelled');

    const qr = verifyQr(config.qrSecret, b.code);
    if (!qr.ok) return this.reject('INVALID_SIGNATURE', ctx, 'Invalid or forged QR code');
    const find = async (): Promise<TicketRow | undefined> =>
      (
        await db.$queryRawUnsafe<TicketRow[]>(`${TICKET_SQL} WHERE t.id = $1::uuid`, qr.ticketId)
      )[0];
    const ticket = await find();
    if (!ticket) return this.reject('TICKET_NOT_FOUND', ctx, 'Ticket not found');
    const refuse = (t: TicketRow): Promise<never> => {
      if (t.event_id !== b.eventId)
        return this.reject('OTHER_EVENT', { ...ctx, ticket: t }, 'Ticket is for another event');
      if (t.status === 'refunded' || t.status === 'cancelled')
        return this.reject('TICKET_REFUNDED', { ...ctx, ticket: t }, 'Ticket was refunded');
      if (qr.version !== t.qr_version)
        return this.reject(
          'TICKET_TRANSFERRED',
          { ...ctx, ticket: t },
          'Ticket was transferred; this QR is no longer valid',
        );
      return this.reject('ALREADY_USED', { ...ctx, ticket: t }, 'Ticket was already used', {
        usedAt: t.used_at?.toISOString() ?? null,
        gate: t.used_gate,
      });
    };
    if (
      ticket.event_id !== b.eventId ||
      ticket.status !== 'valid' ||
      ticket.qr_version !== qr.version
    )
      return refuse(ticket);

    // Atomic admission: of N simultaneous scans exactly one UPDATE matches the `valid` row.
    const won = await db.$queryRaw<{ id: string }[]>`
      UPDATE tickets SET status = 'used', used_at = app_now(), used_gate = ${b.gate}
      WHERE id = ${ticket.id}::uuid AND status = 'valid' AND qr_version = ${qr.version} AND event_id = ${b.eventId}::uuid
      RETURNING id`;
    if (!won[0]) return refuse((await find()) ?? ticket);

    await db.$executeRaw`
      INSERT INTO entrance_scans (ticket_id, event_id, gate, scanner_id, result)
      VALUES (${ticket.id}::uuid, ${b.eventId}::uuid, ${b.gate}, ${u.id}::uuid, 'ADMIT')`;
    await db.$transaction((tx) =>
      addHistory(
        tx,
        ticket.order_id,
        ticket.order_status,
        ticket.order_status,
        `controller:${u.id}`,
        `ticket ${ticket.id} admitted at gate ${b.gate}`,
      ),
    );
    const c = await this.counts(b.eventId);
    return {
      result: 'ADMIT',
      ticketId: ticket.id,
      zoneName: ticket.zone_name,
      row: ticket.row_label,
      number: ticket.seat_number,
      admitted: c.admitted,
      remaining: c.remaining,
    };
  }

  @Get('events/:id/gate-stats')
  @Route({
    summary: 'Admitted and still expected counters for an event',
    roles: ['controller', 'organizer'],
    response: GateStatsDto,
  })
  async stats(
    @CurrentUser() u: AuthUser,
    @UuidParam('id') id: string,
  ): Promise<z.infer<typeof GateStatsDto>> {
    await this.assertGateAccess(id, u, true);
    const c = await this.counts(id);
    return { eventId: id, ...c, total: c.admitted + c.remaining };
  }
}
