import { Injectable } from '@nestjs/common';
import { config } from './config.js';
import { dbNow } from './domain/common.js';
import { admitNext } from './domain/lifecycle.js';
import { AppError } from './errors.js';
import { PrismaService, RealtimeService } from './infra.js';
import type { z } from 'zod';
import type { QueueStateDto } from './dto.js';

type QueueState = z.infer<typeof QueueStateDto>;

interface EntryRow {
  id: string;
  status: QueueState['status'];
  joined_seq: number;
  admit_expires_at: Date | null;
}

/** Average time an admitted user spends selecting; used only for the "approximate wait" estimate. */
const AVG_SELECTION_SECONDS = 120;

/**
 * Virtual queue. Postgres (`queue_entries.joined_seq`, unique(event,user)) is the single source of truth, so
 * order and positions survive a Redis flush and are identical on both api instances. Sockets only notify.
 */
@Injectable()
export class QueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Queue is mandatory for an event when flagged, latched, or when contention exceeds the threshold. */
  async isActive(eventId: string): Promise<boolean> {
    const db = this.prisma.db;
    const rows = await db.$queryRaw<{ queue_enabled: boolean; queue_latched: boolean }[]>`
      SELECT queue_enabled, queue_latched FROM events WHERE id = ${eventId}::uuid`;
    const e = rows[0];
    if (!e) return false;
    if (e.queue_enabled || e.queue_latched) return true;
    const n = await db.$queryRaw<{ n: number }[]>`
      SELECT ((SELECT count(DISTINCT user_id) FROM seat_holds WHERE event_id = ${eventId}::uuid AND status = 'held'
                 AND expires_at > app_now())
            + (SELECT count(*) FROM queue_entries WHERE event_id = ${eventId}::uuid AND status IN ('waiting', 'admitted')))::int AS n`;
    if (n[0]!.n > config.queueTrigger) {
      await db.$executeRaw`UPDATE events SET queue_latched = true WHERE id = ${eventId}::uuid`; // latched: no flapping
      return true;
    }
    return false;
  }

  /** Throws QUEUE_REQUIRED unless the user holds a live admission for this event. */
  async assertAdmitted(eventId: string, userId: string): Promise<void> {
    if (!(await this.isActive(eventId))) return;
    await this.tick(eventId);
    const now = await dbNow(this.prisma.db);
    const rows = await this.prisma.db.$queryRaw<{ ok: boolean }[]>`
      SELECT true AS ok FROM queue_entries
      WHERE event_id = ${eventId}::uuid AND user_id = ${userId}::uuid AND status = 'admitted'
        AND (admit_expires_at IS NULL OR admit_expires_at > ${now})`;
    if (!rows[0])
      throw new AppError('QUEUE_REQUIRED', 'Join the virtual queue to select seats', { eventId });
  }

  /** The user has started selecting: the 5-minute "start" window no longer applies; the slot stays until paid/expired. */
  async markSelecting(
    db: Parameters<typeof admitNext>[0],
    eventId: string,
    userId: string,
  ): Promise<void> {
    await db.$executeRaw`
      UPDATE queue_entries SET admit_expires_at = NULL
      WHERE event_id = ${eventId}::uuid AND user_id = ${userId}::uuid AND status = 'admitted'`;
  }

  /** Runs one admission round; notifies newly admitted users and refreshes positions of those still waiting. */
  async tick(eventId: string): Promise<string[]> {
    const admitted = await this.prisma.db.$transaction(
      (tx) => admitNext(tx, eventId, config.queueMaxSelectors),
      {
        maxWait: 30_000,
        timeout: 30_000,
      },
    );
    if (admitted.length) await this.broadcast(eventId, admitted);
    return admitted;
  }

  private async broadcast(eventId: string, admitted: string[]): Promise<void> {
    const waiting = await this.prisma.db.$queryRaw<{ user_id: string; pos: number }[]>`
      SELECT user_id, row_number() OVER (ORDER BY joined_seq)::int AS pos
      FROM queue_entries WHERE event_id = ${eventId}::uuid AND status = 'waiting' ORDER BY joined_seq LIMIT 2000`;
    for (const u of admitted)
      this.realtime.toUser(u, 'queue:update', { eventId, status: 'admitted' });
    for (const w of waiting) {
      this.realtime.toUser(w.user_id, 'queue:update', {
        eventId,
        status: 'waiting',
        position: w.pos,
      });
    }
  }

  async join(eventId: string, userId: string): Promise<QueueState> {
    const db = this.prisma.db;
    const ev = await db.$queryRaw<
      { status: string }[]
    >`SELECT status::text AS status FROM events WHERE id = ${eventId}::uuid`;
    if (!ev[0] || ev[0].status === 'draft') throw new AppError('NOT_FOUND', 'Event not found');
    if (ev[0].status === 'cancelled')
      throw new AppError('EVENT_CANCELLED', 'The event was cancelled');
    // A finished/expired/left entry is replaced (back of the line); an active one is returned as-is (one place per account).
    await db.$executeRaw`
      DELETE FROM queue_entries WHERE event_id = ${eventId}::uuid AND user_id = ${userId}::uuid
        AND status IN ('done', 'expired', 'left')`;
    await db.$executeRaw`
      INSERT INTO queue_entries (event_id, user_id) VALUES (${eventId}::uuid, ${userId}::uuid)
      ON CONFLICT (event_id, user_id) DO NOTHING`;
    await this.tick(eventId);
    return this.state(eventId, userId);
  }

  async leave(eventId: string, userId: string): Promise<QueueState> {
    await this.prisma.db.$executeRaw`
      UPDATE queue_entries SET status = 'left'
      WHERE event_id = ${eventId}::uuid AND user_id = ${userId}::uuid AND status IN ('waiting', 'admitted')`;
    await this.tick(eventId);
    return this.state(eventId, userId);
  }

  async state(eventId: string, userId: string): Promise<QueueState> {
    const db = this.prisma.db;
    const now = await dbNow(db);
    const rows = await db.$queryRaw<EntryRow[]>`
      SELECT id, status::text AS status, joined_seq::float8 AS joined_seq, admit_expires_at
      FROM queue_entries WHERE event_id = ${eventId}::uuid AND user_id = ${userId}::uuid`;
    const e = rows[0];
    if (!e) throw new AppError('NOT_FOUND', 'You are not in the queue for this event');
    let ahead: number | null = null;
    if (e.status === 'waiting') {
      const r = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM queue_entries
        WHERE event_id = ${eventId}::uuid AND status = 'waiting' AND joined_seq < ${e.joined_seq}::bigint`;
      ahead = r[0]!.n;
    }
    return {
      eventId,
      status: e.status,
      position: ahead === null ? null : ahead + 1,
      ahead,
      estimatedWaitSeconds:
        ahead === null
          ? null
          : Math.ceil((ahead + 1) / config.queueMaxSelectors) * AVG_SELECTION_SECONDS,
      admitExpiresAt: e.admit_expires_at?.toISOString() ?? null,
      maxSelectors: config.queueMaxSelectors,
      serverNow: now.toISOString(),
    };
  }
}
