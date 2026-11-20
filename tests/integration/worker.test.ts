import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@tickets/db';
import {
  advanceTime,
  call,
  createEvent,
  makeUser,
  mails,
  resetTime,
  startApi,
  startMailstub,
  startWorker,
  waitFor,
  type ApiProc,
  type Proc,
  type TestUser,
} from './api-helpers.ts';
import { makeDb } from './helpers.ts';

const SMTP = 1126;
const MAIL_HTTP = 8126;
let db: PrismaClient;
let api: ApiProc;
let mail: Proc;
let redis: Redis;
const workers: Proc[] = [];

beforeAll(async () => {
  db = makeDb(10);
  api = await startApi(3131);
  mail = startMailstub(SMTP, MAIL_HTTP);
  redis = new Redis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379');
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  await mail?.stop();
  await api?.stop();
  redis?.disconnect();
  await db?.$disconnect();
});

const newWorker = (): Proc => {
  const w = startWorker({ apiUrl: api.url, mail: { smtp: SMTP }, port: 3140 + workers.length });
  workers.push(w);
  return w;
};

interface Order {
  id: string;
  status: string;
}

async function paidOrder(
  eventId: string,
  seatId: number,
): Promise<{ buyer: TestUser; orderId: string }> {
  const buyer = await makeUser(db, api.url, 'buyer');
  const h = await call<Order>(api.url, 'POST', '/api/holds', {
    token: buyer.token,
    body: { eventId, seatIds: [seatId] },
    key: randomUUID(),
  });
  expect(h.status).toBe(201);
  const p = await call<{ providerRef: string }>(api.url, 'POST', '/api/payments', {
    token: buyer.token,
    body: { orderId: h.json.id },
    key: randomUUID(),
  });
  expect(p.status).toBe(201);
  await fetch(`${api.url}/stub-pay/pay/${p.json.providerRef}/success`, {
    method: 'POST',
    redirect: 'manual',
  });
  await waitFor(
    async () =>
      (await call<Order>(api.url, 'GET', `/api/orders/${h.json.id}`, { token: buyer.token })).json
        .status === 'paid',
  );
  return { buyer, orderId: h.json.id };
}

describe('worker: e-mail with PDF tickets', () => {
  it('sends the tickets mail with tickets.pdf exactly once', async () => {
    const f = await createEvent(db, api.url, { seats: 3 });
    const { buyer } = await paidOrder(f.eventId, f.seatIds[0]!);
    newWorker();
    const list = await waitFor(async () => {
      const m = await mails(MAIL_HTTP, buyer.email);
      return m.some((x) => x.subject === 'Your tickets') ? m : null;
    }, 30_000);
    const ticketMails = list.filter((m) => m.subject === 'Your tickets');
    expect(ticketMails).toHaveLength(1);
    expect(ticketMails[0]!.attachments.map((a) => a.filename)).toContain('tickets.pdf');
    await workers.pop()!.stop();
  }, 90_000);
});

describe('worker: invariant 3/9 — expiry and payout are driven by the server clock + Postgres, not Redis', () => {
  it('releases expired holds without any manual sweep, even after Redis FLUSHALL', async () => {
    const f = await createEvent(db, api.url, { seats: 3 });
    const buyer = await makeUser(db, api.url, 'buyer');
    const h = await call<Order>(api.url, 'POST', '/api/holds', {
      token: buyer.token,
      body: { eventId: f.eventId, seatIds: [f.seatIds[0]] },
      key: randomUUID(),
    });
    const w = newWorker();
    await advanceTime(api.url, 11 * 60_000);
    try {
      await redis.flushall();
      await waitFor(
        async () =>
          (await call<Order>(api.url, 'GET', `/api/orders/${h.json.id}`, { token: buyer.token }))
            .json.status === 'expired',
        20_000,
      );
    } finally {
      await resetTime(api.url);
      await w.stop();
      workers.splice(workers.indexOf(w), 1);
    }
  }, 90_000);

  it('pays the organizer 3 days after the event: payout = sales − refunds − commission, ledger balanced', async () => {
    const f = await createEvent(db, api.url, { seats: 3 });
    await paidOrder(f.eventId, f.seatIds[0]!);
    const w = newWorker();
    await advanceTime(api.url, 30 * 86_400_000);
    await advanceTime(api.url, 4 * 86_400_000); // event is in 30 days (+3 h fallback length) + 3 days payout delay
    try {
      await waitFor(async () => {
        const r = await db.$queryRaw<
          { status: string }[]
        >`SELECT status::text AS status FROM events WHERE id = ${f.eventId}::uuid`;
        return r[0]?.status === 'paid_out';
      }, 30_000);
      const paid = await db.$queryRaw<{ amount: number }[]>`
        SELECT l.amount_kop::float8 AS amount FROM ledger_entries l JOIN ledger_transactions t ON t.id = l.tx_id
        JOIN ledger_accounts a ON a.id = l.account_id
        WHERE t.operation_type = 'payout_paid' AND t.operation_ref = ${f.eventId} AND a.code = 'organizer_payable'`;
      // 1 ticket × 1000.00 ₴ = 100 000 kop; commission floor(8%) = 8 000; payout = 92 000
      expect(paid[0]!.amount).toBe(92_000);
      const sum = await db.$queryRaw<
        { s: number }[]
      >`SELECT COALESCE(sum(amount_kop), 0)::float8 AS s FROM ledger_entries`;
      expect(sum[0]!.s).toBe(0);
      const fin = await makeUser(db, api.url, 'finance');
      const rec = await call<{ payouts: { eventId: string; matches: boolean }[] }>(
        api.url,
        'GET',
        '/api/finance/reconciliation',
        { token: fin.token },
      );
      expect(rec.json.payouts.find((p) => p.eventId === f.eventId)?.matches).toBe(true);
    } finally {
      await resetTime(api.url);
      await w.stop();
      workers.splice(workers.indexOf(w), 1);
    }
  }, 120_000);
});

describe('worker: invariant 7/8/9 — mass cancel survives chaos, kill -9 of a worker and Redis FLUSHALL', () => {
  it('refunds every order exactly once, within the provider rate limit, with live progress', async () => {
    const N = 14;
    const f = await createEvent(db, api.url, { seats: N });
    const orders: { buyer: TestUser; orderId: string }[] = [];
    for (let i = 0; i < N; i++) orders.push(await paidOrder(f.eventId, f.seatIds[i]!));
    await call(api.url, 'POST', '/__test/stub/chaos', {
      body: { on: true, scenario: 'duplicate' },
    }); // dup webhooks + every 10th request 503
    const w1 = newWorker();
    newWorker();
    try {
      const c = await call<{ total: number }>(api.url, 'POST', `/api/events/${f.eventId}/cancel`, {
        token: f.organizer.token,
      });
      expect(c.json.total).toBe(N);
      // sales and transfers stop immediately
      const late = await call<{ error: { code: string } }>(api.url, 'POST', '/api/holds', {
        token: (await makeUser(db, api.url, 'buyer')).token,
        body: { eventId: f.eventId, seatIds: [f.seatIds[0]] },
        key: randomUUID(),
      });
      expect(late.status).toBe(409);
      expect(late.json.error.code).toBe('EVENT_CANCELLED');
      await w1.kill9(); // crash one replica mid-run
      await redis.flushall(); // and lose every bit of Redis state
      newWorker(); // restart
      try {
        await waitFor(
          async () => {
            const r = await db.$queryRaw<{ n: number }[]>`
              SELECT count(*)::int AS n FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = ${f.eventId}::uuid AND r.status = 'done'`;
            return r[0]!.n === N;
          },
          90_000,
          500,
        );
      } catch (err) {
        const st = await db.$queryRaw<{ status: string; n: number; att: number; locked: number }[]>`
          SELECT r.status::text AS status, count(*)::int AS n, max(r.attempts)::int AS att,
                 count(*) FILTER (WHERE r.locked_until > app_now())::int AS locked
          FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = ${f.eventId}::uuid GROUP BY 1`;
        console.log('REFUND STATES', JSON.stringify(st));
        throw err;
      }
      const counts = await db.$queryRaw<
        { refunds: number; ledger: number; stub: number; progress: number }[]
      >`
        SELECT (SELECT count(*) FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = ${f.eventId}::uuid)::int AS refunds,
               (SELECT count(*) FROM ledger_transactions t JOIN refunds r ON r.id::text = t.operation_ref JOIN orders o ON o.id = r.order_id
                  WHERE t.operation_type = 'refund' AND o.event_id = ${f.eventId}::uuid)::int AS ledger,
               (SELECT count(*) FROM stub_refunds s JOIN refunds r ON r.id::text = s.merchant_ref JOIN orders o ON o.id = r.order_id
                  WHERE o.event_id = ${f.eventId}::uuid)::int AS stub,
               (SELECT done FROM cancel_batches WHERE event_id = ${f.eventId}::uuid)::int AS progress`;
      expect(counts[0]).toEqual({ refunds: N, ledger: N, stub: N, progress: N });
      const batch = await db.$queryRaw<
        { status: string }[]
      >`SELECT status FROM cancel_batches WHERE event_id = ${f.eventId}::uuid`;
      expect(batch[0]!.status).toBe('done');
      // exactly one "Refund processed" mail per buyer (no duplicates after the crash)
      await waitFor(
        async () => {
          const all = await Promise.all(orders.map((o) => mails(MAIL_HTTP, o.buyer.email)));
          return all.every((m) => m.filter((x) => x.subject === 'Refund processed').length >= 1);
        },
        60_000,
        500,
      );
      for (const o of orders) {
        const m = await mails(MAIL_HTTP, o.buyer.email);
        expect(m.filter((x) => x.subject === 'Refund processed')).toHaveLength(1);
        expect(m.filter((x) => x.subject === 'Event cancelled')).toHaveLength(1);
      }
      const max = await call<{ max: number }>(api.url, 'GET', '/__test/stub/max-rps');
      expect(max.json.max).toBeLessThanOrEqual(20);
      const sum = await db.$queryRaw<
        { s: number }[]
      >`SELECT COALESCE(sum(amount_kop), 0)::float8 AS s FROM ledger_entries`;
      expect(sum[0]!.s).toBe(0);
      // repeating the cancel changes nothing
      const again = await call<{ total: number; done: number }>(
        api.url,
        'POST',
        `/api/events/${f.eventId}/cancel`,
        { token: f.organizer.token },
      );
      expect(again.json).toMatchObject({ total: N, done: N });
    } finally {
      await call(api.url, 'POST', '/__test/stub/chaos', { body: { on: false } });
      await Promise.all(workers.splice(0).map((w) => w.stop()));
    }
  }, 240_000);
});
