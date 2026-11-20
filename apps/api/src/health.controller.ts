import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InfraService } from './infra.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly infra: InfraService) {}

  @Get()
  async health(): Promise<{ status: 'ok'; instance: string }> {
    try {
      await this.infra.pool.query('SELECT 1');
      await this.infra.redis.ping();
    } catch (err) {
      // Details stay in server logs; clients only get a fixed message (no host/driver info leak).
      this.logger.error('health check failed', err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException({
        error: { code: 'UNHEALTHY', message: 'dependency unavailable' },
      });
    }
    return { status: 'ok', instance: process.env['INSTANCE_ID'] ?? 'api' };
  }
}
