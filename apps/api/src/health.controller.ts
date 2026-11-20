import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InfraService } from './infra.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly infra: InfraService) {}

  @Get()
  async health(): Promise<{ status: 'ok'; instance: string }> {
    try {
      await this.infra.pool.query('SELECT 1');
      await this.infra.redis.ping();
    } catch (err) {
      throw new ServiceUnavailableException({
        error: { code: 'UNHEALTHY', message: err instanceof Error ? err.message : 'unhealthy' },
      });
    }
    return { status: 'ok', instance: process.env['INSTANCE_ID'] ?? 'api' };
  }
}
