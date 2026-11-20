import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import { z } from 'zod';
import { config } from './config.js';
import { dbNow } from '@tickets/domain';
import { AppError } from '@tickets/domain';
import { PrismaService, RealtimeService } from './infra.js';
import { verifyJwt, type AuthUser } from './jwt.js';

interface SocketData {
  user?: AuthUser;
}
type AuthedSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

const SubscribeSchema = z.object({ eventId: z.string().uuid() });
const ResyncSchema = z.object({ eventId: z.string().uuid(), sinceSeq: z.number().int().min(0) });
const RESYNC_LIMIT = 5000;

type Ack<T> =
  (T & { ok: true }) | { ok: false; error: { code: string; message: string; requestId: string } };

/**
 * Live updates. Rooms: `event:{id}` (seat updates, monotonic per-event seq from Postgres), `user:{id}` (private:
 * queue position, offers, order updates; joined only by the server from the verified token), `cancel:{id}`
 * (mass-cancel progress, organizer-owner only). The Redis adapter fans out across both api instances.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger('Gateway');

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(server: Server): void {
    const pub = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    const sub = pub.duplicate();
    for (const c of [pub, sub])
      c.on('error', (e: Error) => this.logger.warn(`socket adapter redis: ${e.message}`));
    server.adapter(createAdapter(pub, sub));
    this.realtime.attach(server);
  }

  handleConnection(client: AuthedSocket): void {
    const auth = client.handshake.auth as { token?: unknown } | undefined;
    const token = typeof auth?.token === 'string' ? auth.token : '';
    const user = token ? verifyJwt(token) : null;
    if (!user) {
      client.emit('error', this.fail(new AppError('UNAUTHORIZED', 'Authentication required')));
      client.disconnect(true);
      return;
    }
    client.data.user = user;
    void client.join(`user:${user.id}`); // the only way into a user room: server-side, from the verified token
    void dbNow(this.prisma.db).then((now) =>
      client.emit('time:sync', { serverNow: now.toISOString() }),
    );
  }

  private fail(err: unknown): {
    ok: false;
    error: { code: string; message: string; requestId: string };
  } {
    const requestId = randomUUID();
    if (err instanceof AppError)
      return { ok: false, error: { code: err.code, message: err.message, requestId } };
    if (err instanceof z.ZodError)
      return {
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid payload', requestId },
      };
    this.logger.error(
      `socket handler ${requestId} failed`,
      err instanceof Error ? err.stack : String(err),
    );
    return {
      ok: false,
      error: { code: 'INTERNAL', message: 'Unexpected server error', requestId },
    };
  }

  private user(client: AuthedSocket): AuthUser {
    if (!client.data.user) throw new AppError('UNAUTHORIZED', 'Authentication required');
    return client.data.user;
  }

  /** Drafts are visible to their organizer only; everything else is public to authenticated users. */
  private async assertVisible(eventId: string, user: AuthUser): Promise<void> {
    const rows = await this.prisma.db.$queryRaw<{ status: string; organizer_id: string }[]>`
      SELECT status::text AS status, organizer_id FROM events WHERE id = ${eventId}::uuid`;
    const e = rows[0];
    if (!e || (e.status === 'draft' && e.organizer_id !== user.id))
      throw new AppError('NOT_FOUND', 'Event not found');
  }

  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<Ack<{ seq: number; serverNow: string }>> {
    try {
      const user = this.user(client);
      const { eventId } = SubscribeSchema.parse(raw);
      await this.assertVisible(eventId, user);
      await client.join(`event:${eventId}`);
      const seq = await this.prisma.db.$queryRaw<{ seq: number }[]>`
        SELECT COALESCE((SELECT last_seq FROM event_seq WHERE event_id = ${eventId}::uuid), 0)::float8 AS seq`;
      return { ok: true, seq: seq[0]!.seq, serverNow: (await dbNow(this.prisma.db)).toISOString() };
    } catch (err) {
      return this.fail(err);
    }
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<Ack<object>> {
    try {
      this.user(client);
      await client.leave(`event:${SubscribeSchema.parse(raw).eventId}`);
      return { ok: true };
    } catch (err) {
      return this.fail(err);
    }
  }

  /** Catch-up after reconnect: every change with seq > sinceSeq, in order (client drops anything older than it has). */
  @SubscribeMessage('resync')
  async resync(@ConnectedSocket() client: AuthedSocket, @MessageBody() raw: unknown) {
    try {
      const user = this.user(client);
      const { eventId, sinceSeq } = ResyncSchema.parse(raw);
      await this.assertVisible(eventId, user);
      const rows = await this.prisma.db.$queryRaw<
        { seq: number; seat_id: number | null; zone_id: string | null; state: string }[]
      >`
        SELECT seq::float8 AS seq, seat_id::float8 AS seat_id, zone_id, state FROM seat_events
        WHERE event_id = ${eventId}::uuid AND seq > ${sinceSeq}::bigint ORDER BY seq LIMIT ${RESYNC_LIMIT + 1}`;
      const full = rows.length > RESYNC_LIMIT; // too far behind: client must reload the map
      const seq = await this.prisma.db.$queryRaw<{ seq: number }[]>`
        SELECT COALESCE((SELECT last_seq FROM event_seq WHERE event_id = ${eventId}::uuid), 0)::float8 AS seq`;
      return {
        ok: true as const,
        full,
        seq: seq[0]!.seq,
        changes: full
          ? []
          : rows.map((r) => ({ seq: r.seq, seatId: r.seat_id, zoneId: r.zone_id, state: r.state })),
      };
    } catch (err) {
      return this.fail(err);
    }
  }

  @SubscribeMessage('time:sync')
  async timeSync(@ConnectedSocket() client: AuthedSocket): Promise<Ack<{ serverNow: string }>> {
    try {
      this.user(client);
      return { ok: true, serverNow: (await dbNow(this.prisma.db)).toISOString() };
    } catch (err) {
      return this.fail(err);
    }
  }

  /** Mass-cancel progress is for the organizer who owns the event only. */
  @SubscribeMessage('cancel:subscribe')
  async cancelSubscribe(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<Ack<object>> {
    try {
      const user = this.user(client);
      const { eventId } = SubscribeSchema.parse(raw);
      const own = await this.prisma.db.$queryRaw<{ ok: boolean }[]>`
        SELECT true AS ok FROM events WHERE id = ${eventId}::uuid AND organizer_id = ${user.id}::uuid`;
      if (user.role !== 'organizer' || !own[0])
        throw new AppError(
          'FORBIDDEN',
          'Only the organizer of this event can follow its cancellation',
        );
      await client.join(`cancel:${eventId}`);
      return { ok: true };
    } catch (err) {
      return this.fail(err);
    }
  }
}
