import { Controller, Get, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { config } from './config.js';
import { AppError } from './errors.js';
import { PrismaService, RedisService } from './infra.js';
import { Route } from './route.js';

const HealthDto = z.object({ status: z.literal('ok'), instance: z.string() });

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @Route({ summary: 'Liveness + dependency check', public: true, response: HealthDto })
  async health(): Promise<z.infer<typeof HealthDto>> {
    try {
      await this.prisma.db.$queryRaw`SELECT 1`;
      await this.redis.client.ping();
    } catch (err) {
      // Details stay in server logs; clients only get a fixed message (no host/driver info leak).
      this.logger.error('health check failed', err instanceof Error ? err.stack : String(err));
      throw new AppError('SERVICE_UNAVAILABLE', 'dependency unavailable');
    }
    return { status: 'ok', instance: config.instanceId };
  }
}
