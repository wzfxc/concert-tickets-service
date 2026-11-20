import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@tickets/db';
import { call, startApi, type ApiProc } from './api-helpers.ts';
import { makeDb } from './helpers.ts';

let db: PrismaClient;
let api: ApiProc;

beforeAll(async () => {
  db = makeDb(5);
  api = await startApi(3111);
}, 60_000);

afterAll(async () => {
  await api?.stop();
  await db?.$disconnect();
});

/** Real clients retry 429s; so do the tests that are not about rate limiting itself. */
const until = async <T extends { status: number }>(fn: () => Promise<T>): Promise<T> => {
  for (let i = 0; i < 20; i++) {
    const r = await fn();
    if (r.status !== 429) return r;
    await new Promise((x) => setTimeout(x, 100));
  }
  return fn();
};

const createPayment = () =>
  call<{ providerRef?: string; error?: { code: string } }>(
    api.url,
    'POST',
    '/stub-pay/api/payments',
    {
      body: { merchantRef: randomUUID(), amountKop: 10_000 },
    },
  );

describe('payment stub (spec: ≤ 20 requests/second, 429 over the limit, every 10th request 503 in chaos mode)', () => {
  it('answers 429 over 20 rps and never admits more than 20 requests in any second', async () => {
    const results = await Promise.all(Array.from({ length: 80 }, () => createPayment()));
    const ok = results.filter((r) => r.status === 201).length;
    const limited = results.filter((r) => r.status === 429);
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThanOrEqual(25); // one-second burst: ~1 token + refill during the burst
    expect(limited.length).toBe(80 - ok);
    expect(limited[0]!.json.error?.code).toBe('RATE_LIMITED');
    const max = await call<{ max: number }>(api.url, 'GET', '/__test/stub/max-rps');
    expect(max.json.max).toBeLessThanOrEqual(20);
  });

  it('in chaos mode every 10th admitted request is a 503', async () => {
    await new Promise((r) => setTimeout(r, 1200));
    await call(api.url, 'POST', '/__test/stub/chaos', {
      body: { on: true, scenario: 'duplicate' },
    });
    try {
      // Collect 30 *admitted* answers. A 429 is legitimate whenever two admissions land < 50 ms apart
      // (network jitter), so it is retried like any real client would, and not counted.
      const statuses: number[] = [];
      while (statuses.length < 30) {
        const st = (await createPayment()).status;
        if (st !== 429) statuses.push(st);
        await new Promise((r) => setTimeout(r, 70));
      }
      const e503 = statuses.filter((s) => s === 503).length;
      expect(e503, statuses.join(',')).toBeGreaterThanOrEqual(2);
      expect(e503).toBeLessThanOrEqual(4);
      expect(statuses.filter((s) => ![201, 503].includes(s))).toEqual([]);
    } finally {
      await call(api.url, 'POST', '/__test/stub/chaos', { body: { on: false } });
    }
  });

  it('is idempotent on merchantRef and caps cumulative refunds at the payment amount', async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const merchantRef = randomUUID();
    const p1 = await until(() =>
      call<{ providerRef: string }>(api.url, 'POST', '/stub-pay/api/payments', {
        body: { merchantRef, amountKop: 10_000 },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    const p2 = await until(() =>
      call<{ providerRef: string }>(api.url, 'POST', '/stub-pay/api/payments', {
        body: { merchantRef, amountKop: 10_000 },
      }),
    );
    expect([p1.status, p2.status, p2.json.providerRef === p1.json.providerRef]).toEqual([
      201,
      201,
      true,
    ]);
    await fetch(`${api.url}/stub-pay/pay/${p1.json.providerRef}/success`, {
      method: 'POST',
      redirect: 'manual',
    });
    const refund = (amountKop: number, ref = randomUUID()) =>
      until(() =>
        call<{ error?: { code: string } }>(api.url, 'POST', '/stub-pay/api/refunds', {
          body: { merchantRef: ref, paymentRef: p1.json.providerRef, amountKop },
        }),
      );
    await new Promise((r) => setTimeout(r, 100));
    const first = await refund(6_000);
    expect(first.status).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    const over = await refund(5_000);
    expect(over.status).toBe(409);
    expect(over.json.error?.code).toBe('REFUND_EXCEEDS_PAID');
  });

  it('signs webhooks with HMAC-SHA256 (verified by the app) — a tampered body is rejected', async () => {
    const body = JSON.stringify({
      id: 'x',
      type: 'payment.succeeded',
      providerRef: 'sp_x',
      merchantRef: 'm',
      amountKop: 1,
    });
    const good = createHmac('sha256', 'test-webhook-secret').update(body).digest('hex');
    const tampered = await fetch(`${api.url}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-stub-signature': good },
      body: body.replace('"amountKop":1', '"amountKop":2'),
    });
    expect(tampered.status).toBe(403);
  });
});
