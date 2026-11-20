import { Controller, HttpCode, Get, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';
import { config } from './config.js';
import { sweepOnce } from '@tickets/domain';
import { PrismaService, RealtimeService } from './infra.js';
import { QueueService } from './queue.service.js';
import { Route, ZBody } from './route.js';
import { StubService } from './stub.controller.js';

const AdvanceSchema = z.object({
  ms: z
    .number()
    .int()
    .min(0)
    .max(30 * 86_400_000),
});
const ChaosSchema = z.object({
  on: z.boolean(),
  scenario: z.enum(['random', 'duplicate', 'delay', 'reorder', 'drop']).optional(),
});

/**
 * Test-only hooks, mounted ONLY when ENABLE_TEST_CONTROLS=true (never in the production compose profile).
 * Time lives in Postgres (`time_control`), so advancing it is visible to every api/worker process at once.
 */
@ApiExcludeController()
@Controller('__test')
export class TestControlsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly queue: QueueService,
    private readonly stub: StubService,
  ) {}

  @Post('time/advance')
  @HttpCode(200)
  @Route({ summary: 'test: advance the application clock', public: true, body: AdvanceSchema })
  async advance(@ZBody() b: z.infer<typeof AdvanceSchema>) {
    await this.prisma.db
      .$executeRaw`UPDATE time_control SET offset_ms = offset_ms + ${b.ms}::bigint`;
    return { ok: true, serverNow: (await this.prisma.now()).toISOString() };
  }

  @Post('time/reset')
  @HttpCode(200)
  @Route({ summary: 'test: reset the application clock', public: true })
  async reset() {
    await this.prisma.db.$executeRaw`UPDATE time_control SET offset_ms = 0`;
    return { ok: true };
  }

  /** Runs the same sweep the worker runs (expire holds/orders, waitlist offers, queue windows) and publishes the changes. */
  @Post('sweep')
  @HttpCode(200)
  @Route({ summary: 'test: run one sweep now', public: true })
  async sweep() {
    const res = await sweepOnce(this.prisma.db, config.queueMaxSelectors);
    for (const [eventId, changes] of res.changes) this.realtime.seatChanges(eventId, changes);
    for (const eventId of res.events) await this.queue.tick(eventId);
    return { ok: true, expiredOrders: res.expiredOrders };
  }

  @Post('stub/chaos')
  @HttpCode(200)
  @Route({ summary: 'test: switch payment chaos mode at runtime', public: true, body: ChaosSchema })
  async chaos(@ZBody() b: z.infer<typeof ChaosSchema>) {
    await this.prisma.db.$executeRaw`
      INSERT INTO stub_settings (key, value) VALUES ('chaos', ${b.on ? 'on' : 'off'})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await this.prisma.db.$executeRaw`
      INSERT INTO stub_settings (key, value) VALUES ('scenario', ${b.scenario ?? 'random'})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    this.stub.invalidateSettings();
    return { ok: true };
  }

  /** Highest number of provider requests admitted within any 1 s window (must stay <= 20). */
  @Get('stub/max-rps')
  @Route({ summary: 'test: max admitted stub requests per second', public: true })
  async maxRps() {
    const rows = await this.prisma.db.$queryRaw<{ max: number | null }[]>`
      SELECT max(c)::int AS max FROM (
        SELECT count(*) OVER (ORDER BY at RANGE BETWEEN CURRENT ROW AND INTERVAL '999 milliseconds' FOLLOWING) AS c
        FROM stub_request_log WHERE status <> 429) w`;
    return { max: rows[0]?.max ?? 0 };
  }
}
