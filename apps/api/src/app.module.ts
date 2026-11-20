import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthController } from './modules/auth/auth.controller.js';
import { BuyerController } from './modules/orders/buyer.controller.js';
import { config } from './common/config.js';
import { AllExceptionsFilter, RequestIdMiddleware } from './common/errors.js';
import { EventsController } from './modules/events/events.controller.js';
import { FinanceController } from './modules/reporting/finance.controller.js';
import { GateController } from './modules/gate/gate.controller.js';
import { EventsGateway } from './realtime/gateway.js';
import { HealthController } from './modules/health/health.controller.js';
import { IdempotencyService } from './common/idempotency.js';
import { PrismaService, RealtimeService, RedisService, StubApi } from './common/infra.js';
import { OrdersService } from './modules/orders/orders.service.js';
import { OrganizerController } from './modules/organizer/organizer.controller.js';
import { QueueService } from './modules/queue/queue.service.js';
import { RateLimitGuard, RateLimitService } from './common/rate-limit.js';
import { AuthGuard, ZodInterceptor } from './common/route.js';
import { StubController, StubService } from './modules/stub-pay/stub.controller.js';
import { TestControlsController } from './modules/test-controls/test-controls.controller.js';

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
    RateLimitService,
    QueueService,
    OrdersService,
    EventsGateway,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: ZodInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
