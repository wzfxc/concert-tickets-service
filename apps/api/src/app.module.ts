import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { BuyerController } from './buyer.controller.js';
import { config } from './config.js';
import { AllExceptionsFilter, RequestIdMiddleware } from './errors.js';
import { EventsController } from './events.controller.js';
import { FinanceController } from './finance.controller.js';
import { GateController } from './gate.controller.js';
import { EventsGateway } from './gateway.js';
import { HealthController } from './health.controller.js';
import { IdempotencyService } from './idempotency.js';
import { PrismaService, RealtimeService, RedisService, StubApi } from './infra.js';
import { OrdersService } from './orders.service.js';
import { OrganizerController } from './organizer.controller.js';
import { QueueService } from './queue.service.js';
import { AuthGuard, ZodInterceptor } from './route.js';
import { StubController, StubService } from './stub.controller.js';
import { TestControlsController } from './test-controls.controller.js';

@Module({
  controllers: [
    HealthController,
    AuthController,
    EventsController,
    BuyerController,
    OrganizerController,
    GateController,
    FinanceController,
    StubController,
    // Never mounted in production: only with ENABLE_TEST_CONTROLS=true.
    ...(config.testControls ? [TestControlsController] : []),
  ],
  providers: [
    PrismaService,
    RedisService,
    RealtimeService,
    StubApi,
    StubService,
    IdempotencyService,
    QueueService,
    OrdersService,
    EventsGateway,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: ZodInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
