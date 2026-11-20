import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { InfraService } from './infra.service.js';

@Module({ controllers: [HealthController], providers: [InfraService] })
export class AppModule {}
