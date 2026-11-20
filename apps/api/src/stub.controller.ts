import {
  Controller,
  Get,
  HttpCode,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { STUB_CHAOS_503_EVERY } from '@tickets/shared';
import { config } from './config.js';
import { AppError } from './errors.js';
import { PrismaService, RedisService } from './infra.js';
import { Route, ZBody } from './route.js';

const BUCKET_LUA = `
local rate = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil then tokens = cap; ts = now end
-- the Redis clock may step backwards (VM time sync): never let that drain the bucket
if now < ts then ts = now end
tokens = math.min(cap, tokens + (now - ts) * rate / 1000)
local ok = 0
if tokens >= 1 then tokens = tokens - 1; ok = 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 10000)
return ok`;

/** Local fallback bucket, used only while Redis is unreachable (rate is split across api instances). */
class LocalBucket {
  private tokens = 1;
  private last = new Date().getTime();
  take(ratePerSec: number): boolean {
    const now = new Date().getTime();
    this.tokens = Math.min(1, this.tokens + ((now - this.last) * ratePerSec) / 1000);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

type Scenario = 'normal' | 'duplicate' | 'delay' | 'reorder' | 'drop';
const SCENARIOS: Scenario[] = ['normal', 'duplicate', 'delay', 'reorder', 'drop'];

const CreatePaymentSchema = z.object({
  merchantRef: z.string().min(1).max(100),
  amountKop: z.number().int().positive(),
  returnUrl: z.string().max(500).optional(),
});
const CreateRefundSchema = z.object({
  merchantRef: z.string().min(1).max(100),
  paymentRef: z.string().min(1).max(100),
  amountKop: z.number().int().positive(),
});

interface PaymentRow {
  provider_ref: string;
  merchant_ref: string;
  amount_kop: number;
  status: 'pending' | 'succeeded' | 'failed';
  return_url: string | null;
}
interface RefundRow {
  provider_ref: string;
  merchant_ref: string;
  payment_ref: string;
  amount_kop: number;
  status: 'succeeded' | 'failed';
}

const payDto = (p: PaymentRow) => ({
  providerRef: p.provider_ref,
  merchantRef: p.merchant_ref,
  amountKop: p.amount_kop,
  status: p.status,
  payUrl: `/stub-pay/pay/${p.provider_ref}`,
});
const refundDto = (r: RefundRow) => ({
  providerRef: r.provider_ref,
  merchantRef: r.merchant_ref,
  paymentRef: r.payment_ref,
  amountKop: r.amount_kop,
  status: r.status,
});

/** The payment provider stand-in: own tables, own rate limiter, signed webhooks, optional chaos. */
@Injectable()
export class StubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PaymentStub');
  private readonly local = new LocalBucket();
  private localCounter = 0;
  private timer: NodeJS.Timeout | null = null;
  private delivering = false;
  private settings: { at: number; chaos: boolean; scenario: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.deliverDue(), 500);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Chaos switch: `.env` (PAYMENT_CHAOS) unless a test override sits in `stub_settings` (cluster-wide, via Postgres). */
  async chaos(): Promise<{ on: boolean; scenario: string }> {
    const now = new Date().getTime();
    if (!this.settings || now - this.settings.at > 1000) {
      const rows = await this.prisma.db.$queryRaw<
        { key: string; value: string }[]
      >`SELECT key, value FROM stub_settings`;
      const map = new Map(rows.map((r) => [r.key, r.value]));
      this.settings = {
        at: now,
        chaos: map.has('chaos') ? map.get('chaos') === 'on' : config.paymentChaos,
        scenario: map.get('scenario') ?? config.paymentChaosScenario,
      };
    }
    return { on: this.settings.chaos, scenario: this.settings.scenario };
  }

  invalidateSettings(): void {
    this.settings = null;
  }

  private async takeToken(): Promise<boolean> {
    try {
      const ok = await this.redis.client.eval(
        BUCKET_LUA,
        1,
        'stub:bucket',
        String(config.stubRps),
        '1',
      );
      return ok === 1;
    } catch {
      // Redis down: degrade to a per-instance bucket at rps / instances so the cluster still stays <= 20 rps.
      return this.local.take(config.stubRps / Math.max(1, config.apiInstances));
    }
  }

  private async nextCount(): Promise<number> {
    try {
      return await this.redis.client.incr('stub:chaos:count');
    } catch {
      return ++this.localCounter;
    }
  }

  /** Every stub API request passes here: 20 rps cluster-wide (429 over the limit), every 10th request 503 in chaos mode. */
  async admit(path: string): Promise<void> {
    const log = (status: number) =>
      this.prisma.db
        .$executeRaw`INSERT INTO stub_request_log (path, status) VALUES (${path}, ${status})`.catch(
        () => 0,
      );
    if (!(await this.takeToken())) {
      await log(429);
      throw new AppError(
        'RATE_LIMITED',
        'Payment provider rate limit exceeded (20 requests/second)',
      );
    }
    if ((await this.chaos()).on && (await this.nextCount()) % STUB_CHAOS_503_EVERY === 0) {
      await log(503);
      throw new AppError('SERVICE_UNAVAILABLE', 'Payment provider temporarily unavailable');
    }
    await log(200);
  }

  private pickScenario(sc: string, type: string): Scenario {
    const s: Scenario = (SCENARIOS as string[]).includes(sc)
      ? (sc as Scenario)
      : SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)]!;
    return s === 'reorder' && type !== 'payment.succeeded' ? 'duplicate' : s;
  }

  /** Queues the webhook(s) for an outcome according to the chaos scenario (dup, ≤60 s delay, reorder, drop). */
  async emit(
    type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'refund.failed',
    providerRef: string,
    merchantRef: string,
    amountKop: number,
  ): Promise<void> {
    const chaos = await this.chaos();
    const scenario: Scenario = chaos.on ? this.pickScenario(chaos.scenario, type) : 'normal';
    const body = (t: string, id: string) =>
      JSON.stringify({ id, type: t, providerRef, merchantRef, amountKop });
    const put = (payload: string, delaySec: number, t: string) =>
      this.prisma.db.$executeRaw`
        INSERT INTO stub_webhooks (provider_ref, event_type, payload, due_at)
        VALUES (${providerRef}, ${t}, ${payload}::jsonb, app_now() + make_interval(secs => ${delaySec}::float8))`;
    const id = randomUUID();
    if (scenario === 'drop') return;
    if (scenario === 'delay') return void (await put(body(type, id), 1 + Math.random() * 59, type));
    await put(body(type, id), 0, type);
    if (scenario === 'duplicate') await put(body(type, id), Math.random() * 2, type);
    if (scenario === 'reorder')
      await put(body('payment.failed', randomUUID()), 1 + Math.random() * 2, 'payment.failed');
  }

  private sign(raw: string): string {
    return createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
  }

  /** Delivery loop (every api instance runs it; SKIP LOCKED claims make each webhook go out once per attempt). */
  private async deliverDue(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      const due = await this.prisma.db.$queryRaw<
        { id: number; payload: unknown; attempts: number }[]
      >`
        UPDATE stub_webhooks SET locked_until = app_now() + interval '30 seconds', attempts = attempts + 1
        WHERE id IN (SELECT id FROM stub_webhooks WHERE delivered_at IS NULL AND due_at <= app_now()
                       AND (locked_until IS NULL OR locked_until <= app_now()) AND attempts < 30
                     ORDER BY due_at, id LIMIT 20 FOR UPDATE SKIP LOCKED)
        RETURNING id::float8 AS id, payload, attempts`;
      await Promise.all(
        due.map(async (w) => {
          const raw = JSON.stringify(w.payload);
          try {
            const res = await fetch(config.webhookUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-stub-signature': this.sign(raw) },
              body: raw,
              signal: AbortSignal.timeout(15_000),
            });
            if (res.ok) {
              await this.prisma.db
                .$executeRaw`UPDATE stub_webhooks SET delivered_at = app_now() WHERE id = ${w.id}::bigint`;
              return;
            }
          } catch {
            // network error: retried with backoff below
          }
          const backoff = Math.min(2 ** w.attempts, 30);
          await this.prisma.db.$executeRaw`
            UPDATE stub_webhooks SET locked_until = app_now() + make_interval(secs => ${backoff}::float8) WHERE id = ${w.id}::bigint`;
        }),
      );
    } catch (err) {
      this.logger.warn(
        `webhook delivery loop: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.delivering = false;
    }
  }

  // ───────────── payments / refunds ─────────────

  async createPayment(b: z.infer<typeof CreatePaymentSchema>) {
    const ref = `sp_${randomBytes(12).toString('hex')}`;
    await this.prisma.db.$executeRaw`
      INSERT INTO stub_payments (provider_ref, merchant_ref, amount_kop, return_url)
      VALUES (${ref}, ${b.merchantRef}, ${b.amountKop}::bigint, ${b.returnUrl ?? null})
      ON CONFLICT (merchant_ref) DO NOTHING`;
    const rows = await this.prisma.db.$queryRaw<PaymentRow[]>`
      SELECT provider_ref, merchant_ref, amount_kop::float8 AS amount_kop, status, return_url
      FROM stub_payments WHERE merchant_ref = ${b.merchantRef}`;
    return rows[0]!;
  }

  async getPayment(ref: string): Promise<PaymentRow | undefined> {
    const rows = await this.prisma.db.$queryRaw<PaymentRow[]>`
      SELECT provider_ref, merchant_ref, amount_kop::float8 AS amount_kop, status, return_url FROM stub_payments WHERE provider_ref = ${ref}`;
    return rows[0];
  }

  /** The buyer pressed a button on the stub page. `close` sends nothing (the merchant must reconcile). */
  async act(ref: string, action: 'success' | 'fail' | 'close'): Promise<PaymentRow> {
    const p = await this.getPayment(ref);
    if (!p) throw new AppError('NOT_FOUND', 'Unknown payment');
    if (action === 'close' || p.status !== 'pending') return p;
    const next = action === 'success' ? 'succeeded' : 'failed';
    const n = await this.prisma.db.$executeRaw`
      UPDATE stub_payments SET status = ${next}, updated_at = now() WHERE provider_ref = ${ref} AND status = 'pending'`;
    if (n === 1)
      await this.emit(
        action === 'success' ? 'payment.succeeded' : 'payment.failed',
        ref,
        p.merchant_ref,
        p.amount_kop,
      );
    return { ...p, status: next };
  }

  async createRefund(b: z.infer<typeof CreateRefundSchema>): Promise<RefundRow> {
    const db = this.prisma.db;
    const created = await db.$transaction(async (tx) => {
      const pay = await tx.$queryRaw<PaymentRow[]>`
        SELECT provider_ref, merchant_ref, amount_kop::float8 AS amount_kop, status, return_url
        FROM stub_payments WHERE provider_ref = ${b.paymentRef} FOR UPDATE`;
      if (!pay[0]) throw new AppError('NOT_FOUND', 'Unknown payment');
      const existing = await tx.$queryRaw<RefundRow[]>`
        SELECT provider_ref, merchant_ref, payment_ref, amount_kop::float8 AS amount_kop, status FROM stub_refunds WHERE merchant_ref = ${b.merchantRef}`;
      if (existing[0]) return { row: existing[0], fresh: false };
      if (pay[0].status !== 'succeeded')
        throw new AppError('INVALID_STATE', 'Payment was not successful');
      const used = await tx.$queryRaw<{ s: number }[]>`
        SELECT COALESCE(sum(amount_kop), 0)::float8 AS s FROM stub_refunds WHERE payment_ref = ${b.paymentRef} AND status = 'succeeded'`;
      if (used[0]!.s + b.amountKop > pay[0].amount_kop)
        throw new AppError('REFUND_EXCEEDS_PAID', 'Refund exceeds the payment amount');
      const ref = `sr_${randomBytes(12).toString('hex')}`;
      await tx.$executeRaw`
        INSERT INTO stub_refunds (provider_ref, merchant_ref, payment_ref, amount_kop)
        VALUES (${ref}, ${b.merchantRef}, ${b.paymentRef}, ${b.amountKop}::bigint)`;
      return {
        row: {
          provider_ref: ref,
          merchant_ref: b.merchantRef,
          payment_ref: b.paymentRef,
          amount_kop: b.amountKop,
          status: 'succeeded' as const,
        },
        fresh: true,
      };
    });
    if (created.fresh)
      await this.emit('refund.succeeded', created.row.provider_ref, b.merchantRef, b.amountKop);
    return created.row;
  }

  async getRefund(ref: string): Promise<RefundRow | undefined> {
    const rows = await this.prisma.db.$queryRaw<RefundRow[]>`
      SELECT provider_ref, merchant_ref, payment_ref, amount_kop::float8 AS amount_kop, status FROM stub_refunds WHERE provider_ref = ${ref}`;
    return rows[0];
  }
}

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}
button{font-size:1rem;padding:.7rem 1rem;margin:.3rem .3rem .3rem 0;cursor:pointer}form{display:inline}
.ok{background:#16a34a;color:#fff;border:0;border-radius:.4rem}.fail{background:#dc2626;color:#fff;border:0;border-radius:.4rem}
.close{background:#e5e7eb;border:0;border-radius:.4rem}</style></head><body>${body}</body></html>`;

@ApiExcludeController()
@Controller('stub-pay')
export class StubController {
  constructor(private readonly stub: StubService) {}

  // ───────────── provider API (rate limited) ─────────────

  @Post('api/payments')
  @HttpCode(201)
  @Route({ summary: 'stub: create payment', public: true, body: CreatePaymentSchema, status: 201 })
  async create(@ZBody() b: z.infer<typeof CreatePaymentSchema>) {
    await this.stub.admit('POST /payments');
    return payDto(await this.stub.createPayment(b));
  }

  @Get('api/payments/:ref')
  @Route({ summary: 'stub: payment status', public: true })
  async status(@Param('ref') ref: string) {
    await this.stub.admit('GET /payments');
    const p = await this.stub.getPayment(ref);
    if (!p) throw new AppError('NOT_FOUND', 'Unknown payment');
    return payDto(p);
  }

  @Post('api/refunds')
  @HttpCode(201)
  @Route({
    summary: 'stub: create refund (full or partial)',
    public: true,
    body: CreateRefundSchema,
    status: 201,
  })
  async refund(@ZBody() b: z.infer<typeof CreateRefundSchema>) {
    await this.stub.admit('POST /refunds');
    return refundDto(await this.stub.createRefund(b));
  }

  @Get('api/refunds/:ref')
  @Route({ summary: 'stub: refund status', public: true })
  async refundStatus(@Param('ref') ref: string) {
    await this.stub.admit('GET /refunds');
    const r = await this.stub.getRefund(ref);
    if (!r) throw new AppError('NOT_FOUND', 'Unknown refund');
    return refundDto(r);
  }

  // ───────────── hosted payment page ─────────────

  @Get('pay/:ref')
  @Route({ summary: 'stub: payment page', public: true })
  async payPage(@Param('ref') ref: string, @Res() res: Response): Promise<void> {
    const p = await this.stub.getPayment(ref);
    if (!p) {
      res.status(404).type('html').send(page('Not found', '<h1>Payment not found</h1>'));
      return;
    }
    const amount = (p.amount_kop / 100).toFixed(2);
    const form = (action: string, cls: string, label: string) =>
      `<form method="post" action="/stub-pay/pay/${p.provider_ref}/${action}"><button class="${cls}" type="submit">${label}</button></form>`;
    res.type('html').send(
      page(
        'Payment stub',
        `<h1>Payment stub</h1><p>Order reference: <code>${p.merchant_ref}</code></p><p>Amount: <b>${amount} UAH</b></p>
<p>Status: <b id="status">${p.status}</b></p>
${p.status === 'pending' ? form('success', 'ok', 'Success') + form('fail', 'fail', 'Fail') + form('close', 'close', 'Close without response') : '<p>This payment is already finished.</p>'}
${p.return_url ? `<p><a href="${encodeURI(p.return_url)}">Back to the shop</a></p>` : ''}`,
      ),
    );
  }

  @Post('pay/:ref/:action')
  @HttpCode(200)
  @Route({ summary: 'stub: press a button on the payment page', public: true })
  async payAction(
    @Param('ref') ref: string,
    @Param('action') action: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!['success', 'fail', 'close'].includes(action))
      throw new AppError('VALIDATION_ERROR', 'Unknown action');
    const p = await this.stub.act(ref, action as 'success' | 'fail' | 'close');
    if (action !== 'close' && p.return_url?.startsWith('/')) {
      res.redirect(303, p.return_url);
      return;
    }
    res
      .type('html')
      .send(
        page(
          'Payment stub',
          action === 'close'
            ? '<h1>Closed</h1><p>No response was sent to the shop.</p>'
            : `<h1>Done</h1><p>Payment ${p.status}.</p>`,
        ),
      );
  }
}
