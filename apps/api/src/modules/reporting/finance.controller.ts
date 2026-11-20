import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { ManualRefundSchema, ReportPeriodSchema } from '@tickets/shared';
import {
  FinanceReportDto,
  JobsDto,
  OkDto,
  ReconciliationDto,
  RefundDto,
} from '../../common/dto.js';
import { reconcileProvider } from '@tickets/domain';
import { AppError } from '@tickets/domain';
import { IdempotencyService } from '../../common/idempotency.js';
import { PrismaService, StubApi } from '../../common/infra.js';
import type { AuthUser } from '../../common/jwt.js';
import { OrdersService } from '../orders/orders.service.js';
import { CurrentUser, IdemKey, IntParam, Route, ZBody, ZQuery } from '../../common/route.js';

const FIN = ['finance'] as const;
type Period = z.infer<typeof ReportPeriodSchema>;

const day = (s: string): Date => new Date(`${s}T00:00:00Z`);

@ApiTags('finance')
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly idem: IdempotencyService,
    private readonly stub: StubApi,
  ) {}

  @Get('report')
  @Route({
    summary: 'Period report: sales, service fees, commission, refunds, payouts, per organizer',
    roles: FIN,
    query: ReportPeriodSchema,
    response: FinanceReportDto,
  })
  async report(@ZQuery() q: Period): Promise<z.infer<typeof FinanceReportDto>> {
    const from = day(q.from);
    const to = new Date(day(q.to).getTime() + 86_400_000); // `to` is inclusive
    if (to <= from) throw new AppError('VALIDATION_ERROR', '`to` must not be before `from`');
    // Sign convention: debit +, credit −. Revenue accounts are credits, so flip the sign for display.
    const rows = await this.prisma.db.$queryRaw<
      { organizer_id: string | null; code: string; typ: string; amount: number }[]
    >`SELECT a.organizer_id, a.code, t.operation_type AS typ, sum(e.amount_kop)::float8 AS amount
      FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.tx_id
      WHERE e.created_at >= ${from} AND e.created_at < ${to}
      GROUP BY a.organizer_id, a.code, t.operation_type`;
    const totals = {
      salesKop: 0,
      serviceFeesKop: 0,
      commissionKop: 0,
      refundsKop: 0,
      payoutsKop: 0,
    };
    const per = new Map<
      string,
      { salesKop: number; refundsKop: number; commissionKop: number; payoutsKop: number }
    >();
    const slot = (id: string) => {
      const cur = per.get(id) ?? { salesKop: 0, refundsKop: 0, commissionKop: 0, payoutsKop: 0 };
      per.set(id, cur);
      return cur;
    };
    for (const r of rows) {
      if (r.code === 'ticket_revenue_liability' && r.typ === 'payment' && r.organizer_id) {
        totals.salesKop -= r.amount;
        slot(r.organizer_id).salesKop -= r.amount;
      } else if (r.code === 'service_fee_revenue') {
        totals.serviceFeesKop -= r.amount; // payments credit it, fee refunds debit it
      } else if (r.code === 'commission_revenue') {
        totals.commissionKop -= r.amount;
        if (r.organizer_id) slot(r.organizer_id).commissionKop -= r.amount;
      } else if (r.code === 'refunds' && r.organizer_id) {
        totals.refundsKop += r.amount;
        slot(r.organizer_id).refundsKop += r.amount;
      } else if (r.code === 'organizer_payable' && r.typ === 'payout_paid' && r.organizer_id) {
        totals.payoutsKop += r.amount;
        slot(r.organizer_id).payoutsKop += r.amount;
      }
    }
    const names = per.size
      ? await this.prisma.db.$queryRaw<
          { id: string; name: string }[]
        >`SELECT id, name FROM users WHERE id = ANY (${[...per.keys()]}::uuid[])`
      : [];
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals,
      byOrganizer: [...per.entries()].map(([organizerId, v]) => ({
        organizerId,
        organizerName: nameOf.get(organizerId) ?? '',
        ...v,
      })),
    };
  }

  @Get('reconciliation')
  @Route({
    summary: 'Ledger sums, account balances vs entries, payout checks, provider discrepancies',
    roles: FIN,
    response: ReconciliationDto,
  })
  async reconciliation(): Promise<z.infer<typeof ReconciliationDto>> {
    const db = this.prisma.db;
    const sum = await db.$queryRaw<
      { s: number }[]
    >`SELECT COALESCE(sum(amount_kop), 0)::float8 AS s FROM ledger_entries`;
    const accounts = await db.$queryRaw<
      { code: string; organizer_id: string | null; balance: number; entries: number }[]
    >`
      SELECT b.code, b.organizer_id, b.balance_kop::float8 AS balance,
             COALESCE((SELECT sum(e.amount_kop) FROM ledger_entries e WHERE e.account_id = b.account_id), 0)::float8 AS entries
      FROM ledger_balances b ORDER BY b.code, b.organizer_id NULLS FIRST`;
    // Paid-out events: payout must equal sales − refunds − commission (commission rounded in the organizer's favour).
    const payouts = await db.$queryRaw<{ event_id: string; expected: number; posted: number }[]>`
      SELECT e.id AS event_id,
        (s.sales - s.refunds - floor((s.sales - s.refunds) * 8 / 100.0))::float8 AS expected,
        COALESCE((SELECT sum(l.amount_kop) FROM ledger_entries l JOIN ledger_transactions t ON t.id = l.tx_id
                  JOIN ledger_accounts a ON a.id = l.account_id
                  WHERE t.operation_type = 'payout_paid' AND t.operation_ref = e.id::text AND a.code = 'organizer_payable'), 0)::float8 AS posted
      FROM events e
      JOIN LATERAL (SELECT COALESCE(sum(oi.price_kop - oi.discount_kop), 0) AS sales,
                           COALESCE((SELECT sum(r.amount_kop - r.fee_kop) FROM refunds r JOIN orders o2 ON o2.id = r.order_id
                                     WHERE o2.event_id = e.id AND r.status = 'done'), 0) AS refunds
                    FROM orders o JOIN order_items oi ON oi.order_id = o.id
                    WHERE o.event_id = e.id AND o.paid_at IS NOT NULL AND o.paid_kop > 0
                      AND o.paid_kop > 0) s ON true
      WHERE e.status = 'paid_out'`;
    const { discrepancies } = await reconcileProvider(db, this.stub, {
      apply: false,
      olderThanSeconds: 0,
      limit: 50,
    });
    return {
      ledgerSumKop: sum[0]!.s,
      balanced: sum[0]!.s === 0,
      accounts: accounts.map((a) => ({
        code: a.code,
        organizerId: a.organizer_id,
        balanceKop: a.balance,
        entriesSumKop: a.entries,
        matches: a.balance === a.entries,
      })),
      // `posted` is the (negative-signed credit) payable posted at payout, so compare magnitudes.
      payouts: payouts.map((p) => ({
        eventId: p.event_id,
        expectedKop: p.expected,
        postedKop: Math.abs(p.posted),
        matches: Math.abs(p.posted) === p.expected,
      })),
      discrepancies,
    };
  }

  @Post('reconciliation/run')
  @HttpCode(200)
  @Route({
    summary:
      'Run provider reconciliation now: finds operations stuck without a webhook and applies them (idempotent)',
    roles: FIN,
    response: ReconciliationDto,
  })
  async runReconciliation(): Promise<z.infer<typeof ReconciliationDto>> {
    await reconcileProvider(this.prisma.db, this.stub, {
      apply: true,
      olderThanSeconds: 0,
      limit: 100,
    });
    return this.reconciliation();
  }

  @Post('refunds')
  @Route({
    summary: 'Manual refund for an order with a reason (capped by what was paid)',
    roles: FIN,
    body: ManualRefundSchema,
    response: RefundDto,
    status: 201,
    idempotent: true,
  })
  manualRefund(
    @CurrentUser() u: AuthUser,
    @ZBody() b: z.infer<typeof ManualRefundSchema>,
    @IdemKey() key?: string,
  ) {
    return this.idem.run(`manual-refund:${u.id}`, key, b, () =>
      this.orders.manualRefund(u.id, b, key as string),
    );
  }

  @Get('jobs')
  @Route({ summary: 'Failed and stuck background jobs', roles: FIN, response: JobsDto })
  async jobs(): Promise<z.infer<typeof JobsDto>> {
    const db = this.prisma.db;
    const failed = await db.$queryRaw<
      {
        id: number;
        queue: string;
        job_key: string;
        error: string;
        attempts: number;
        failed_at: Date;
        retried_at: Date | null;
      }[]
    >`SELECT id::float8 AS id, queue, job_key, error, attempts, failed_at, retried_at FROM failed_jobs ORDER BY failed_at DESC LIMIT 200`;
    const stuck = await db.$queryRaw<{ queue: string; key: string; state: string; age: number }[]>`
      SELECT 'refund' AS queue, id::text AS key, status::text AS state, extract(epoch FROM (app_now() - updated_at))::int AS age
        FROM refunds WHERE status IN ('pending', 'sent') AND updated_at < app_now() - interval '5 minutes'
      UNION ALL
      SELECT 'payment', id::text, status::text, extract(epoch FROM (app_now() - created_at))::int
        FROM payments WHERE status = 'pending' AND created_at < app_now() - interval '5 minutes'
      UNION ALL
      SELECT 'email', id::text, status, extract(epoch FROM (app_now() - created_at))::int
        FROM email_outbox WHERE status = 'pending' AND created_at < app_now() - interval '5 minutes'
      ORDER BY 4 DESC LIMIT 200`;
    return {
      failed: failed.map((f) => ({
        id: f.id,
        queue: f.queue,
        jobKey: f.job_key,
        error: f.error,
        attempts: f.attempts,
        failedAt: f.failed_at.toISOString(),
        retriedAt: f.retried_at?.toISOString() ?? null,
      })),
      stuck: stuck.map((s) => ({ queue: s.queue, key: s.key, state: s.state, ageSeconds: s.age })),
    };
  }

  /** Re-arms the underlying work item; the handlers are idempotent (ledger op refs, refund ids), so a retry never duplicates. */
  @Post('jobs/:id/retry')
  @HttpCode(200)
  @Route({
    summary: 'Retry a failed job (safe: nothing is duplicated)',
    roles: FIN,
    response: OkDto,
  })
  async retry(@IntParam('id') id: number): Promise<z.infer<typeof OkDto>> {
    const db = this.prisma.db;
    const rows = await db.$queryRaw<{ queue: string; job_key: string }[]>`
      SELECT queue, job_key FROM failed_jobs WHERE id = ${id}::bigint`;
    const job = rows[0];
    if (!job) throw new AppError('NOT_FOUND', 'Job not found');
    if (job.queue === 'refund') {
      await db.$executeRaw`
        UPDATE refunds SET status = 'pending', attempts = 0, locked_until = NULL, updated_at = now()
        WHERE id = ${job.job_key}::uuid AND status = 'failed'`;
    } else if (job.queue === 'email') {
      await db.$executeRaw`
        UPDATE email_outbox SET status = 'pending', attempts = 0, locked_until = NULL WHERE dedup_key = ${job.job_key} AND status = 'failed'`;
    }
    await db.$executeRaw`UPDATE failed_jobs SET retried_at = now() WHERE id = ${id}::bigint`;
    return { ok: true };
  }
}
