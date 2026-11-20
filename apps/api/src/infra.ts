import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import { createPrismaClient, type PrismaClient } from '@tickets/db';
import { config } from './config.js';
import { StubClient } from './domain/stubClient.js';

/** Prisma client (pool shared by this api instance). Connects lazily on first query. */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly db: PrismaClient = createPrismaClient(config.databaseUrl, config.dbPoolSize);

  /** Domain "now": the DB clock plus the test time offset (`app_now()`), never the Node clock. */
  async now(): Promise<Date> {
    const rows = await this.db.$queryRaw<{ now: Date }[]>`SELECT app_now() AS now`;
    return rows[0]!.now;
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger('Redis');
  readonly client = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  constructor() {
    // Redis is only a cache/notification channel: outages are logged, never fatal.
    this.client.on('error', (err: Error) => this.logger.warn(`redis error: ${err.message}`));
    this.client.connect().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}

/** HTTP client for the payment stub (the app only talks to the "provider" over HTTP). */
@Injectable()
export class StubApi extends StubClient {
  constructor() {
    super(config.stubBaseUrl);
  }
}

export interface SeatChangeMessage {
  seq: number;
  seatId: number | null;
  zoneId: string | null;
  state: 'free' | 'held' | 'sold' | 'offered';
}

/**
 * Fan-out to Socket.IO rooms. The Redis adapter makes `to(room).emit` reach clients connected to the
 * other api instance, so callers do not care which instance served the originating request.
 */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  attach(server: Server): void {
    this.server = server;
  }

  seatChanges(eventId: string, changes: SeatChangeMessage[]): void {
    if (!changes.length) return;
    this.server?.to(`event:${eventId}`).emit('seat:update', { eventId, changes });
  }

  toUser(userId: string, event: string, payload: object): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  eventStatus(eventId: string, status: string): void {
    this.server?.to(`event:${eventId}`).emit('event:status', { eventId, status });
  }

  cancelProgress(eventId: string, payload: object): void {
    this.server?.to(`cancel:${eventId}`).emit('cancel:progress', payload);
  }
}
