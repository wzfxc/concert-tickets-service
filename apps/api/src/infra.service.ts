import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import pg from 'pg';

@Injectable()
export class InfraService implements OnModuleDestroy {
  readonly pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 10 });
  readonly redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
  });

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}
