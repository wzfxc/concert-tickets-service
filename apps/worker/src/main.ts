import http from 'node:http';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { Emitter } from '@socket.io/redis-emitter';
import { createPrismaClient, type PrismaClient } from '@tickets/db';
import { StubClient, reconcileProvider, sweepOnce, type ChangesByEvent } from '@tickets/domain';
import { config } from './config.js';
import {
  handleEmail,
  handleRefund,
  handlePayout,
  finishEvents,
  dueEmails,
  dueRefunds,
  duePayouts,
} from './jobs.js';

/**
 * Reliability model (README "Background jobs"): Postgres holds every obligation (refund rows, email_outbox, events due
 * for payout, expiring orders). A DB-driven dispatcher re-derives due work every tick and enqueues BullMQ jobs with
 * deterministic job ids; handlers are idempotent (leases in PG, provider calls keyed by our ids, unique ledger refs).
 * A Redis FLUSHALL therefore only loses queue bookkeeping; the next tick re-adds whatever is still due.
 */
const prisma: PrismaClient = createPrismaClient(config.databaseUrl, config.dbPoolSize);
const stub = new StubClient(config.stubBaseUrl);
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
connection.on('error', (e: Error) => console.warn('redis:', e.message));
const emitterRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
emitterRedis.on('error', () => undefined);
const emitter = new Emitter(emitterRedis);

const QUEUES = { refund: 'refund', email: 'email', payout: 'payout' } as const;
const jobOpts = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 500,
};
const queues = {
  refund: new Queue(QUEUES.refund, { connection, defaultJobOptions: jobOpts }),
  email: new Queue(QUEUES.email, { connection, defaultJobOptions: jobOpts }),
  payout: new Queue(QUEUES.payout, { connection, defaultJobOptions: jobOpts }),
};

function publish(changes: ChangesByEvent): void {
  for (const [eventId, list] of changes)
    emitter.to(`event:${eventId}`).emit('seat:update', { eventId, changes: list });
}

async function emitCancelProgress(refundId: string): Promise<void> {
  const rows = await prisma.$queryRaw<
    { event_id: string; total: number; done: number; status: string; kind: string }[]
  >`
    SELECT o.event_id, b.total, b.done, b.status, r.kind FROM refunds r JOIN orders o ON o.id = r.order_id
    JOIN cancel_batches b ON b.event_id = o.event_id WHERE r.id = ${refundId}::uuid`;
  const r = rows[0];
  if (r?.kind === 'cancellation') {
    emitter.to(`cancel:${r.event_id}`).emit('cancel:progress', {
      eventId: r.event_id,
      total: r.total,
      done: r.done,
      status: r.status,
    });
  }
}

/** Records a job that exhausted its attempts, so finance sees it and can retry it safely. */
async function recordFailure(
  queue: string,
  jobKey: string,
  payload: unknown,
  error: string,
  attempts: number,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO failed_jobs (queue, job_key, payload, error, attempts)
    VALUES (${queue}, ${jobKey}, ${JSON.stringify(payload ?? null)}::jsonb, ${error.slice(0, 1000)}, ${attempts})
    ON CONFLICT (queue, job_key) DO UPDATE SET error = EXCLUDED.error, attempts = EXCLUDED.attempts, failed_at = now(), retried_at = NULL`;
}

function worker<T>(
  name: string,
  fn: (job: Job<T>) => Promise<void>,
  opts: { concurrency: number; limiter?: { max: number; duration: number } },
): Worker<T> {
  const w = new Worker<T>(name, fn, { connection, ...opts });
  w.on('error', (e) => console.warn(`${name} worker error:`, e.message));
  w.on('failed', (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const key = String((job.data as { id?: string }).id ?? job.id);
      void recordFailure(name, key, job.data, err.message, job.attemptsMade);
    }
  });
  return w;
}

// Global limiter shared by every replica through Redis: one provider refund every ~1/(stubRps-2) s, i.e. below the provider's strict 20 rps.
const workers = [
  worker<{ id: string }>(
    QUEUES.refund,
    async (job) => {
      // 429/503 from the provider are handled by the refund row itself (lease + exponential backoff + attempts cap);
      // the dispatcher re-adds it when due, so the BullMQ job does not need to fail.
      await handleRefund(prisma, stub, job.data.id);
      await emitCancelProgress(job.data.id).catch(() => undefined);
    },
    {
      concurrency: 4,
      limiter: { max: 1, duration: Math.ceil(1000 / Math.max(1, config.stubRps - 2)) + 5 },
    },
  ),
  worker<{ id: number }>(QUEUES.email, (job) => handleEmail(prisma, job.data.id), {
    concurrency: 4,
  }),
  worker<{ id: string }>(QUEUES.payout, (job) => handlePayout(prisma, job.data.id), {
    concurrency: 2,
  }),
];

let ticking = false;
let lastReconcile = 0;

/** One dispatcher round: tidy time-driven state, then enqueue everything the DB says is due. */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const sweep = await sweepOnce(prisma, config.queueMaxSelectors);
    publish(sweep.changes);
    await finishEvents(prisma);
    for (const r of await dueRefunds(prisma)) {
      await queues.refund.add('refund', { id: r.id }, { jobId: `refund-${r.id}-${r.attempts}` });
    }
    for (const e of await dueEmails(prisma)) {
      await queues.email.add('email', { id: e.id }, { jobId: `email-${e.id}-${e.attempts}` });
    }
    for (const p of await duePayouts(prisma)) {
      await queues.payout.add('payout', { id: p.id }, { jobId: `payout-${p.id}` });
    }
    const now = new Date().getTime();
    if (now - lastReconcile >= config.reconcileMs) {
      lastReconcile = now;
      // Only one replica reconciles per interval (advisory lock); the handlers are idempotent anyway.
      const got = await prisma.$queryRaw<
        { ok: boolean }[]
      >`SELECT pg_try_advisory_lock(727001) AS ok`;
      if (got[0]?.ok) {
        try {
          const res = await reconcileProvider(prisma, stub, {
            apply: true,
            olderThanSeconds: 60,
            limit: 40,
          });
          for (const o of res.outcomes) publish(o.changes);
        } finally {
          await prisma.$queryRaw`SELECT pg_advisory_unlock(727001)`;
        }
      }
    }
  } catch (err) {
    console.warn('tick failed:', err instanceof Error ? err.message : String(err));
  } finally {
    ticking = false;
  }
}

const timer = setInterval(() => void tick(), config.tickMs);
void tick();

const server = http.createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404).end();
    return;
  }
  Promise.all([prisma.$queryRaw`SELECT 1`, connection.ping()])
    .then(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'))
    .catch(() => res.writeHead(503).end('{"status":"unhealthy"}'));
});
server.listen(config.port, '0.0.0.0');

async function shutdown(): Promise<void> {
  clearInterval(timer);
  server.close();
  await Promise.allSettled([
    ...workers.map((w) => w.close()),
    ...Object.values(queues).map((q) => q.close()),
  ]);
  await Promise.allSettled([prisma.$disconnect(), connection.quit(), emitterRedis.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
