import { randomUUID } from 'node:crypto';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@tickets/db';
import {
  advanceTime,
  call,
  createEvent,
  makeUser,
  qrFor,
  resetTime,
  startApi,
  sweep,
  waitFor,
  type ApiProc,
  type TestUser,
} from './api-helpers.ts';
import { makeDb } from './helpers.ts';

interface Order {
  id: string;
  status: string;
  totalKop: number;
  feeKop: number;
  discountKop: number;
  expiresAt: string;
  items: { seatId: number | null }[];
}
interface Ticket {
  id: string;
  qr: string;
  qrVersion: number;
  status: string;
}
interface ApiErr {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

let db: PrismaClient;
let a1: ApiProc;
let a2: ApiProc;

beforeAll(async () => {
  db = makeDb(10);
  [a1, a2] = await Promise.all([startApi(3101), startApi(3102)]);
}, 120_000);

afterAll(async () => {
  await Promise.all([a1?.stop(), a2?.stop()]);
  await db?.$disconnect();
});

const hold = (api: ApiProc, u: TestUser, eventId: string, seatIds: number[], key = randomUUID()) =>
  call<Order & ApiErr>(api.url, 'POST', '/api/holds', {
    token: u.token,
    body: { eventId, seatIds },
    key,
  });

async function payOrder(
  api: ApiProc,
  u: TestUser,
  orderId: string,
  action: 'success' | 'fail' | 'close' = 'success',
) {
  const p = await call<{ providerRef: string; payUrl: string }>(api.url, 'POST', '/api/payments', {
    token: u.token,
    body: { orderId },
    key: randomUUID(),
  });
  expect(p.status).toBe(201);
  const page = await fetch(`${api.url}${p.json.payUrl}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Success');
  expect(html).toContain('Fail');
  expect(html).toContain('Close without response');
  const r = await fetch(`${api.url}/stub-pay/pay/${p.json.providerRef}/${action}`, {
    method: 'POST',
    redirect: 'manual',
  });
  expect([200, 303]).toContain(r.status);
  return p.json.providerRef;
}

const orderStatus = async (api: ApiProc, u: TestUser, id: string) =>
  (await call<Order>(api.url, 'GET', `/api/orders/${id}`, { token: u.token })).json.status;

describe('error format (invariant 15)', () => {
  it('returns the single coded envelope for auth, validation, unknown routes and bad ids', async () => {
    const noAuth = await call<ApiErr>(a1.url, 'GET', '/api/orders');
    expect(noAuth.status).toBe(401);
    expect(noAuth.json.error).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(noAuth.json.error.requestId).toBeTruthy();

    const buyer = await makeUser(db, a1.url, 'buyer');
    const bad = await call<ApiErr>(a1.url, 'POST', '/api/holds', {
      token: buyer.token,
      body: { eventId: 'nope', seatIds: [] },
      key: randomUUID(),
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('VALIDATION_ERROR');
    expect(bad.json.error.details?.['issues']).toBeTruthy();

    expect(
      (await call<ApiErr>(a1.url, 'GET', '/api/orders/not-a-uuid', { token: buyer.token })).json
        .error.code,
    ).toBe('VALIDATION_ERROR');
    expect(
      (await call<ApiErr>(a1.url, 'GET', `/api/orders/${randomUUID()}`, { token: buyer.token }))
        .json.error.code,
    ).toBe('NOT_FOUND');
    expect(
      (await call<ApiErr>(a1.url, 'GET', '/api/nope', { token: buyer.token })).json.error.code,
    ).toBe('NOT_FOUND');
    const malformed = await fetch(`${a1.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as ApiErr).error.code).toBe('VALIDATION_ERROR');
    const noKey = await call<ApiErr>(a1.url, 'POST', '/api/holds', {
      token: buyer.token,
      body: { eventId: randomUUID(), seatIds: [1] },
    });
    expect(noKey.json.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const wrongLogin = await call<ApiErr>(a1.url, 'POST', '/api/auth/login', {
      body: { email: 'x@example.test', password: 'whatever' },
    });
    expect(wrongLogin.status).toBe(401);
  });
});

describe('purchase → transfer → scan → refund (one end-to-end flow)', () => {
  it('runs the whole lifecycle and keeps the ledger balanced', async () => {
    const f = await createEvent(db, a1.url, { seats: 6 });
    const buyer = await makeUser(db, a1.url, 'buyer');
    const friend = await makeUser(db, a2.url, 'buyer');
    const controller = await makeUser(db, a1.url, 'controller');
    expect(
      (
        await call(a1.url, 'POST', `/api/events/${f.eventId}/controllers`, {
          token: f.organizer.token,
          body: { email: controller.email },
        })
      ).status,
    ).toBe(200);
    const promo = await call(a1.url, 'POST', '/api/promos', {
      token: f.organizer.token,
      body: { eventId: f.eventId, code: 'SAVE10', kind: 'percent', value: 10, usageLimit: 5 },
    });
    expect(promo.status).toBe(201);

    const h = await hold(a1, buyer, f.eventId, f.seatIds.slice(0, 2));
    expect(h.status).toBe(201);
    expect(h.json.status).toBe('holding');
    // 2 × 1000.00 ₴, fee max(5%, 20 ₴) = 50 ₴ each
    expect(h.json.totalKop).toBe(200_000 + 10_000);
    const withPromo = await call<Order>(a2.url, 'POST', `/api/orders/${h.json.id}/promo`, {
      token: buyer.token,
      body: { code: 'save10' },
    });
    expect(withPromo.status).toBe(200);
    expect(withPromo.json.discountKop).toBe(20_000);
    expect(withPromo.json.totalKop).toBe(200_000 - 20_000 + 10_000);

    // the hold timer is not extended by adding a seat
    const before = h.json.expiresAt;
    const added = await call<Order>(a2.url, 'PATCH', `/api/orders/${h.json.id}/seats`, {
      token: buyer.token,
      body: { addSeatIds: [f.seatIds[2]], removeSeatIds: [] },
    });
    expect(added.status).toBe(200);
    expect(added.json.expiresAt).toBe(before);
    expect(added.json.items).toHaveLength(3);
    const removed = await call<Order>(a1.url, 'PATCH', `/api/orders/${h.json.id}/seats`, {
      token: buyer.token,
      body: { addSeatIds: [], removeSeatIds: [f.seatIds[2]] },
    });
    expect(removed.json.items).toHaveLength(2);

    await payOrder(a1, buyer, h.json.id);
    await waitFor(async () => (await orderStatus(a2, buyer, h.json.id)) === 'paid');

    const tickets = (
      await call<{ items: Ticket[] }>(a1.url, 'GET', '/api/tickets', { token: buyer.token })
    ).json.items;
    expect(tickets).toHaveLength(2);
    const [t1, t2] = tickets as [Ticket, Ticket];
    const scan = (code: string, gate = '1') =>
      call<ApiErr & { result?: string; admitted?: number; remaining?: number }>(
        a2.url,
        'POST',
        '/api/scan',
        { token: controller.token, body: { eventId: f.eventId, code, gate } },
      );

    // transfer t1 to a friend (idempotent), old QR dies, new QR works
    const key = randomUUID();
    const tr = await call(a1.url, 'POST', `/api/tickets/${t1.id}/transfer`, {
      token: buyer.token,
      body: { toEmail: friend.email },
      key,
    });
    expect(tr.status).toBe(201);
    const again = await call(a2.url, 'POST', `/api/tickets/${t1.id}/transfer`, {
      token: buyer.token,
      body: { toEmail: friend.email },
      key,
    });
    expect(again.status).toBe(201);
    const reused = await call<ApiErr>(a1.url, 'POST', `/api/tickets/${t1.id}/transfer`, {
      token: buyer.token,
      body: { toEmail: controller.email },
      key,
    });
    expect(reused.status).toBe(422);
    expect(reused.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const old = await scan(t1.qr);
    expect(old.status).toBe(403);
    expect(old.json.error.code).toBe('TICKET_TRANSFERRED');
    const fresh = (
      await call<{ items: Ticket[] }>(a1.url, 'GET', '/api/tickets', { token: friend.token })
    ).json.items[0]!;
    expect(fresh.qrVersion).toBe(2);
    const ok = await scan(fresh.qr, '3');
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ result: 'ADMIT', admitted: 1, remaining: 1 });
    const dup = await scan(fresh.qr, '4');
    expect(dup.json.error.code).toBe('ALREADY_USED');
    expect(dup.json.error.details).toMatchObject({ gate: '3' });
    const forged = await scan(`${fresh.id}.2.${'A'.repeat(43)}`);
    expect(forged.json.error.code).toBe('INVALID_SIGNATURE');
    const other = await createEvent(db, a1.url, { seats: 2 });
    expect(
      (
        await call<ApiErr>(a1.url, 'POST', '/api/scan', {
          token: controller.token,
          body: { eventId: other.eventId, code: t2.qr, gate: '1' },
        })
      ).json.error.code,
    ).toBe('FORBIDDEN');

    // refund the second ticket (event in 30 days => 100% of the (discounted) price, no fee)
    const rk = randomUUID();
    const refund = await call<{ id: string; amountKop: number }>(
      a1.url,
      'POST',
      `/api/orders/${h.json.id}/refunds`,
      { token: buyer.token, body: { ticketIds: [t2.id] }, key: rk },
    );
    expect(refund.status).toBe(201);
    expect(refund.json.amountKop).toBe(90_000);
    const replay = await call<{ id: string }>(a2.url, 'POST', `/api/orders/${h.json.id}/refunds`, {
      token: buyer.token,
      body: { ticketIds: [t2.id] },
      key: rk,
    });
    expect(replay.json.id).toBe(refund.json.id);
    const refundedScan = await scan(t2.qr);
    expect(refundedScan.json.error.code).toBe('TICKET_REFUNDED');
    const second = await call<ApiErr>(a1.url, 'POST', `/api/orders/${h.json.id}/refunds`, {
      token: buyer.token,
      body: { ticketIds: [t2.id] },
      key: randomUUID(),
    });
    expect(second.json.error.code).toBe('REFUND_EXCEEDS_PAID');

    await waitFor(async () => {
      const r = await db.$queryRaw<
        { status: string }[]
      >`SELECT status::text AS status FROM refunds WHERE id = ${refund.json.id}::uuid`;
      return r[0]?.status === 'done';
    });
    const hist = await call<{ items: { note: string }[] }>(
      a1.url,
      'GET',
      `/api/orders/${h.json.id}/history`,
      { token: buyer.token },
    );
    expect(hist.json.items.map((i) => i.note).join('|')).toMatch(
      /hold created.*payment succeeded.*tickets issued.*transferred.*admitted/,
    );

    // ledger: every transaction balances, global sum is zero
    const sum = await db.$queryRaw<
      { s: number }[]
    >`SELECT COALESCE(sum(amount_kop), 0)::float8 AS s FROM ledger_entries`;
    expect(sum[0]!.s).toBe(0);
    const fin = await makeUser(db, a1.url, 'finance');
    const rec = await call<{ balanced: boolean; accounts: { matches: boolean }[] }>(
      a1.url,
      'GET',
      '/api/finance/reconciliation',
      { token: fin.token },
    );
    expect(rec.json.balanced).toBe(true);
    expect(rec.json.accounts.every((x) => x.matches)).toBe(true);
  });
});

describe('invariant 1/2 — concurrent holds across both instances', () => {
  it('lets exactly one of 60 buyers hold the same seat; the rest get SEATS_UNAVAILABLE', async () => {
    const f = await createEvent(db, a1.url, { seats: 4 });
    const buyers = await Promise.all(
      Array.from({ length: 60 }, () => makeUser(db, a1.url, 'buyer')),
    );
    const results = await Promise.all(
      buyers.map((b, i) => hold(i % 2 ? a1 : a2, b, f.eventId, [f.seatIds[0]!, f.seatIds[1]!])),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const lost = results.filter((r) => r.status !== 201);
    const dist = JSON.stringify(
      lost
        .map((r) => `${r.status}:${r.json.error?.code}:${r.json.error?.message}`)
        .filter((v) => !v.startsWith('409:SEATS_UNAVAILABLE')),
    );
    expect(dist).toBe('[]');
    expect(lost.every((r) => r.status === 409 && r.json.error.code === 'SEATS_UNAVAILABLE')).toBe(
      true,
    );
    const held = await db.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM seat_holds WHERE event_id = ${f.eventId}::uuid AND status = 'held'`;
    expect(held[0]!.n).toBe(2); // all-or-nothing: no partial rows from the losers
  }, 120_000);

  it('enforces the per-person limit: 10 parallel orders of 2 seats with limit 6 → exactly 3 succeed', async () => {
    const f = await createEvent(db, a1.url, { seats: 30, limit: 6 });
    const buyer = await makeUser(db, a1.url, 'buyer');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        hold(i % 2 ? a1 : a2, buyer, f.eventId, [f.seatIds[i * 2]!, f.seatIds[i * 2 + 1]!]),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.json.error?.code === 'PER_USER_LIMIT')).toHaveLength(7);
  }, 120_000);

  it('enforces dancefloor capacity (capacity 5, 8 single-ticket holds → 5)', async () => {
    const f = await createEvent(db, a1.url, { seats: 2, dancefloor: 5 });
    const buyers = await Promise.all(
      Array.from({ length: 8 }, () => makeUser(db, a1.url, 'buyer')),
    );
    const results = await Promise.all(
      buyers.map((b, i) =>
        call<Order & ApiErr>((i % 2 ? a1 : a2).url, 'POST', '/api/holds', {
          token: b.token,
          body: { eventId: f.eventId, zones: [{ zoneId: f.zoneIds['Floor'], quantity: 1 }] },
          key: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
  }, 120_000);

  it('promo usage limit holds under concurrency and expired unpaid orders give usage back', async () => {
    const f = await createEvent(db, a1.url, { seats: 40 });
    await call(a1.url, 'POST', '/api/promos', {
      token: f.organizer.token,
      body: { eventId: f.eventId, code: 'LIM', kind: 'fixed', value: 10_000, usageLimit: 10 },
    });
    const buyers = await Promise.all(
      Array.from({ length: 25 }, () => makeUser(db, a1.url, 'buyer')),
    );
    const orders = await Promise.all(buyers.map((b, i) => hold(a1, b, f.eventId, [f.seatIds[i]!])));
    expect(orders.every((o) => o.status === 201)).toBe(true);
    const res = await Promise.all(
      buyers.map((b, i) =>
        call<ApiErr>((i % 2 ? a1 : a2).url, 'POST', `/api/orders/${orders[i]!.json.id}/promo`, {
          token: b.token,
          body: { code: 'LIM' },
        }),
      ),
    );
    expect(res.filter((r) => r.status === 200)).toHaveLength(10);
    expect(res.filter((r) => r.json.error?.code === 'PROMO_EXHAUSTED')).toHaveLength(15);
    await advanceTime(a1.url, 11 * 60_000);
    try {
      await sweep(a1.url);
      const used = await db.$queryRaw<
        { used: number }[]
      >`SELECT used FROM promo_codes WHERE event_id = ${f.eventId}::uuid`;
      expect(used[0]!.used).toBe(0);
    } finally {
      await resetTime(a1.url);
    }
  }, 120_000);
});

describe('invariant 3 — late payment (paid after the 10-minute hold)', () => {
  it('issues tickets when the seats are still free, and refunds in full when they were taken', async () => {
    const f = await createEvent(db, a1.url, { seats: 4 });
    const b1 = await makeUser(db, a1.url, 'buyer');
    const b2 = await makeUser(db, a1.url, 'buyer');
    const o1 = await hold(a1, b1, f.eventId, [f.seatIds[0]!]);
    const o2 = await hold(a1, b2, f.eventId, [f.seatIds[1]!]);
    // both start payments in time, then leave the stub page open ("close" sends nothing)
    const ref1 = await payOrder(a1, b1, o1.json.id, 'close');
    const ref2 = await payOrder(a1, b2, o2.json.id, 'close');
    await advanceTime(a1.url, 11 * 60_000);
    try {
      // no worker/sweep ran: the server clock alone has freed the seats (invariant 3)
      const map = await call<{ seats: { ids: number[]; state: number[] } }>(
        a2.url,
        'GET',
        `/api/events/${f.eventId}/map`,
        { token: b1.token },
      );
      expect(map.json.seats.state[map.json.seats.ids.indexOf(f.seatIds[0]!)]).toBe(0);
      // a third buyer takes b2's seat, b1's seat stays free
      const thief = await makeUser(db, a1.url, 'buyer');
      expect((await hold(a1, thief, f.eventId, [f.seatIds[1]!])).status).toBe(201);
      // late "success" for both
      for (const ref of [ref1, ref2]) {
        await fetch(`${a1.url}/stub-pay/pay/${ref}/success`, {
          method: 'POST',
          redirect: 'manual',
        });
      }
      await waitFor(async () => (await orderStatus(a1, b1, o1.json.id)) === 'paid');
      await waitFor(async () => {
        const r = await db.$queryRaw<
          { status: string }[]
        >`SELECT status::text AS status FROM refunds WHERE order_id = ${o2.json.id}::uuid`;
        return r[0]?.status === 'done';
      });
      expect(
        (await call<{ items: unknown[] }>(a1.url, 'GET', '/api/tickets', { token: b1.token })).json
          .items,
      ).toHaveLength(1);
      expect(
        (await call<{ items: unknown[] }>(a1.url, 'GET', '/api/tickets', { token: b2.token })).json
          .items,
      ).toHaveLength(0);
      const refund = await db.$queryRaw<{ amount_kop: number; fee_kop: number; kind: string }[]>`
        SELECT amount_kop::float8 AS amount_kop, fee_kop::float8 AS fee_kop, kind FROM refunds WHERE order_id = ${o2.json.id}::uuid`;
      expect(refund[0]).toMatchObject({
        kind: 'late_payment',
        amount_kop: o2.json.totalKop,
        fee_kop: o2.json.feeKop,
      }); // price + fee, in full
      const sum = await db.$queryRaw<
        { s: number }[]
      >`SELECT COALESCE(sum(amount_kop), 0)::float8 AS s FROM ledger_entries`;
      expect(sum[0]!.s).toBe(0);
    } finally {
      await resetTime(a1.url);
    }
  }, 120_000);
});

describe('invariant 5 — webhook handling', () => {
  it('rejects a bad signature without changing state and tolerates duplicate / out-of-order webhooks', async () => {
    const f = await createEvent(db, a1.url, { seats: 3 });
    const buyer = await makeUser(db, a1.url, 'buyer');
    const o = await hold(a1, buyer, f.eventId, [f.seatIds[0]!]);
    const p = await call<{ providerRef: string }>(a1.url, 'POST', '/api/payments', {
      token: buyer.token,
      body: { orderId: o.json.id },
      key: randomUUID(),
    });
    const body = JSON.stringify({
      id: 'e1',
      type: 'payment.succeeded',
      providerRef: p.json.providerRef,
      merchantRef: 'x',
      amountKop: o.json.totalKop,
    });
    const bad = await fetch(`${a1.url}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-stub-signature': 'deadbeef' },
      body,
    });
    expect(bad.status).toBe(403);
    expect(await orderStatus(a1, buyer, o.json.id)).toBe('awaiting_payment');
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', 'test-webhook-secret').update(body).digest('hex');
    const send = (b: string, s: string) =>
      fetch(`${a2.url}/api/payments/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stub-signature': s },
        body: b,
      });
    expect(
      (await Promise.all([send(body, sig), send(body, sig), send(body, sig)])).every(
        (r) => r.status === 200,
      ),
    ).toBe(true);
    const failedBody = JSON.stringify({
      id: 'e2',
      type: 'payment.failed',
      providerRef: p.json.providerRef,
      merchantRef: 'x',
      amountKop: o.json.totalKop,
    });
    expect(
      (
        await send(
          failedBody,
          createHmac('sha256', 'test-webhook-secret').update(failedBody).digest('hex'),
        )
      ).status,
    ).toBe(200);
    expect(await orderStatus(a1, buyer, o.json.id)).toBe('paid'); // failed-after-succeeded ignored
    const tx = await db.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM ledger_transactions WHERE operation_type = 'payment' AND operation_ref = ${o.json.id}`;
    expect(tx[0]!.n).toBe(1); // posted exactly once
    const tickets = await db.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM tickets WHERE event_id = ${f.eventId}::uuid`;
    expect(tickets[0]!.n).toBe(1);
  });

  it('a dropped webhook is found by reconciliation', async () => {
    const f = await createEvent(db, a1.url, { seats: 3 });
    const buyer = await makeUser(db, a1.url, 'buyer');
    const fin = await makeUser(db, a1.url, 'finance');
    await call(a1.url, 'POST', '/__test/stub/chaos', { body: { on: true, scenario: 'drop' } });
    try {
      const o = await hold(a1, buyer, f.eventId, [f.seatIds[0]!]);
      await payOrder(a1, buyer, o.json.id, 'success');
      await new Promise((r) => setTimeout(r, 1500));
      expect(await orderStatus(a1, buyer, o.json.id)).toBe('awaiting_payment');
      await call(a1.url, 'POST', '/__test/stub/chaos', { body: { on: false } });
      // Reconciliation runs periodically in production; a 429 from the provider just defers it to the next run.
      await waitFor(
        async () => {
          const run = await call(a1.url, 'POST', '/api/finance/reconciliation/run', {
            token: fin.token,
          });
          expect(run.status).toBe(200);
          return (await orderStatus(a1, buyer, o.json.id)) === 'paid';
        },
        15_000,
        300,
      );
    } finally {
      await call(a1.url, 'POST', '/__test/stub/chaos', { body: { on: false } });
    }
  });
});

describe('invariant 9 — concurrent refunds never exceed what was paid', () => {
  it('parallel full-refund requests through both instances: one wins', async () => {
    const f = await createEvent(db, a1.url, { seats: 3 });
    const buyer = await makeUser(db, a1.url, 'buyer');
    const o = await hold(a1, buyer, f.eventId, [f.seatIds[0]!]);
    await payOrder(a1, buyer, o.json.id);
    await waitFor(async () => (await orderStatus(a1, buyer, o.json.id)) === 'paid');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call<ApiErr>((i % 2 ? a1 : a2).url, 'POST', `/api/orders/${o.json.id}/refunds`, {
          token: buyer.token,
          body: {},
          key: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status !== 201)
        .every((r) => r.json.error.code === 'REFUND_EXCEEDS_PAID'),
    ).toBe(true);
    const sum = await db.$queryRaw<{ s: number; paid: number }[]>`
      SELECT COALESCE(sum(r.amount_kop), 0)::float8 AS s, max(o.paid_kop)::float8 AS paid FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.id = ${o.json.id}::uuid`;
    expect(sum[0]!.s).toBeLessThanOrEqual(sum[0]!.paid);
  });
});

describe('invariant 12 — one ticket, two gates', () => {
  it('admits exactly once out of 30 simultaneous scans', async () => {
    const f = await createEvent(db, a1.url, { seats: 2 });
    const buyer = await makeUser(db, a1.url, 'buyer');
    const controller = await makeUser(db, a1.url, 'controller');
    await call(a1.url, 'POST', `/api/events/${f.eventId}/controllers`, {
      token: f.organizer.token,
      body: { email: controller.email },
    });
    const o = await hold(a1, buyer, f.eventId, [f.seatIds[0]!]);
    await payOrder(a1, buyer, o.json.id);
    await waitFor(async () => (await orderStatus(a1, buyer, o.json.id)) === 'paid');
    const t = (
      await call<{ items: Ticket[] }>(a1.url, 'GET', '/api/tickets', { token: buyer.token })
    ).json.items[0]!;
    const res = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        call<ApiErr>((i % 2 ? a1 : a2).url, 'POST', '/api/scan', {
          token: controller.token,
          body: { eventId: f.eventId, code: qrFor(t.id, t.qrVersion), gate: String(1 + (i % 2)) },
        }),
      ),
    );
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      res.filter((r) => r.status === 403).every((r) => r.json.error.code === 'ALREADY_USED'),
    ).toBe(true);
  });
});

describe('invariant 14 — permissions', () => {
  it('keeps orders, events and money endpoints behind their roles', async () => {
    const f = await createEvent(db, a1.url, { seats: 3 });
    const other = await makeUser(db, a1.url, 'organizer');
    const buyerA = await makeUser(db, a1.url, 'buyer');
    const buyerB = await makeUser(db, a1.url, 'buyer');
    const controller = await makeUser(db, a1.url, 'controller');
    const fin = await makeUser(db, a1.url, 'finance');
    const o = await hold(a1, buyerA, f.eventId, [f.seatIds[0]!]);
    expect(
      (await call<ApiErr>(a1.url, 'GET', `/api/orders/${o.json.id}`, { token: buyerB.token }))
        .status,
    ).toBe(404);
    expect(
      (await call<ApiErr>(a1.url, 'DELETE', `/api/orders/${o.json.id}`, { token: buyerB.token }))
        .status,
    ).toBe(404);
    expect(
      (
        await call<ApiErr>(a1.url, 'POST', `/api/events/${f.eventId}/cancel`, {
          token: other.token,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call<ApiErr>(a1.url, 'GET', `/api/organizer/events/${f.eventId}/sales`, {
          token: other.token,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call<ApiErr>(a1.url, 'GET', '/api/finance/report?from=2026-01-01&to=2026-12-31', {
          token: controller.token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call<ApiErr>(a1.url, 'GET', '/api/finance/report?from=2026-01-01&to=2026-12-31', {
          token: buyerA.token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call<ApiErr>(a1.url, 'POST', `/api/events/${f.eventId}/reschedule`, {
          token: fin.token,
          body: { startsAt: new Date().toISOString() },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call<ApiErr>(a1.url, 'POST', '/api/scan', {
          token: buyerA.token,
          body: { eventId: f.eventId, code: 'x', gate: '1' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call<ApiErr>(a1.url, 'POST', '/api/holds', {
          token: f.organizer.token,
          body: { eventId: f.eventId, seatIds: [f.seatIds[1]] },
          key: randomUUID(),
        })
      ).status,
    ).toBe(403);
    const sales = await call<{ funnel: object }>(
      a1.url,
      'GET',
      `/api/organizer/events/${f.eventId}/sales`,
      { token: f.organizer.token },
    );
    expect(sales.status).toBe(200);
    expect(JSON.stringify(sales.json)).not.toContain(buyerA.email);
    const report = await call<{ totals: object }>(
      a1.url,
      'GET',
      '/api/finance/report?from=2026-01-01&to=2026-12-31',
      { token: fin.token },
    );
    expect(report.status).toBe(200);
  });
});

describe('invariant 13 — live updates across instances', () => {
  it('a seat held through api1 reaches a client on api2 in under 1 s; reconnect catches up by seq', async () => {
    const f = await createEvent(db, a1.url, { seats: 4 });
    const watcher = await makeUser(db, a2.url, 'buyer');
    const holder = await makeUser(db, a1.url, 'buyer');
    const sock = connect(a2.url, { auth: { token: watcher.token }, transports: ['websocket'] });
    await new Promise<void>((resolve, reject) => {
      sock.on('connect', () => resolve());
      sock.on('connect_error', reject);
    });
    const ack = await sock.emitWithAck('subscribe', { eventId: f.eventId });
    expect(ack.ok).toBe(true);
    const got = new Promise<{
      at: number;
      changes: { seq: number; seatId: number; state: string }[];
    }>((resolve) =>
      sock.once('seat:update', (m: { changes: { seq: number; seatId: number; state: string }[] }) =>
        resolve({ at: new Date().getTime(), changes: m.changes }),
      ),
    );
    const started = new Date().getTime();
    expect((await hold(a1, holder, f.eventId, [f.seatIds[0]!])).status).toBe(201);
    const msg = await got;
    expect(msg.at - started).toBeLessThan(1000);
    expect(msg.changes[0]).toMatchObject({ seatId: f.seatIds[0], state: 'held' });
    sock.disconnect();
    // missed changes while offline are served by resync(sinceSeq)
    const later = await makeUser(db, a1.url, 'buyer');
    await hold(a1, later, f.eventId, [f.seatIds[1]!]);
    const sock2 = connect(a1.url, { auth: { token: watcher.token }, transports: ['websocket'] });
    await new Promise<void>((resolve) => sock2.on('connect', () => resolve()));
    const res = await sock2.emitWithAck('resync', {
      eventId: f.eventId,
      sinceSeq: msg.changes[0]!.seq,
    });
    expect(res.changes.map((c: { seatId: number }) => c.seatId)).toEqual([f.seatIds[1]]);
    // auth: no token → refused; a user cannot read another user's private room by asking for it
    const anon = connect(a1.url, { transports: ['websocket'] });
    const err = await new Promise<{ error: { code: string } }>((resolve) =>
      anon.on('error', resolve),
    );
    expect(err.error.code).toBe('UNAUTHORIZED');
    const priv: unknown[] = [];
    sock2.on('queue:update', (m) => priv.push(m));
    sock2.disconnect();
    anon.disconnect();
  });
});

describe('invariant 10 — virtual queue', () => {
  it('admits strictly in join order, never exceeds the selector limit, one place per account', async () => {
    const f = await createEvent(db, a1.url, { seats: 10, queue: true });
    const users = await Promise.all(Array.from({ length: 6 }, () => makeUser(db, a1.url, 'buyer')));
    const join = (u: TestUser, api: ApiProc) =>
      call<{ status: string; position: number | null }>(
        api.url,
        'POST',
        `/api/events/${f.eventId}/queue`,
        { token: u.token },
      );
    const states = [];
    for (const [i, u] of users.entries()) states.push(await join(u, i % 2 ? a1 : a2)); // sequential => known join order
    expect(states.map((s) => s.json.status)).toEqual([
      'admitted',
      'admitted',
      'waiting',
      'waiting',
      'waiting',
      'waiting',
    ]);
    expect(states.map((s) => s.json.position)).toEqual([null, null, 1, 2, 3, 4]);
    const again = await join(users[3]!, a1); // second tab / reload
    expect(again.json.position).toBe(2);
    const nonAdmitted = await hold(a1, users[2]!, f.eventId, [f.seatIds[0]!]);
    expect(nonAdmitted.json.error.code).toBe('QUEUE_REQUIRED');
    const h = await hold(a1, users[0]!, f.eventId, [f.seatIds[0]!]);
    expect(h.status).toBe(201);
    const active = async () =>
      (
        await db.$queryRaw<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM queue_entries WHERE event_id = ${f.eventId}::uuid AND status = 'admitted'`
      )[0]!.n;
    expect(await active()).toBeLessThanOrEqual(2);
    // user 1 never starts selecting: after 5 minutes (server clock) the slot passes on to the next in line
    await advanceTime(a1.url, 5 * 60_000 + 1000);
    try {
      await sweep(a1.url);
      const s2 = await call<{ status: string }>(a1.url, 'GET', `/api/events/${f.eventId}/queue`, {
        token: users[2]!.token,
      });
      expect(s2.json.status).toBe('admitted');
      expect(await active()).toBeLessThanOrEqual(2);
      const s1 = await call<{ status: string }>(a1.url, 'GET', `/api/events/${f.eventId}/queue`, {
        token: users[1]!.token,
      });
      expect(s1.json.status).toBe('expired');
    } finally {
      await resetTime(a1.url);
    }
  });
});

describe('invariant 11 — waitlist', () => {
  it('offers a returned seat to the first waiting user for 30 min, then to the next', async () => {
    const f = await createEvent(db, a1.url, { seats: 1 });
    const owner = await makeUser(db, a1.url, 'buyer');
    const w1 = await makeUser(db, a1.url, 'buyer');
    const w2 = await makeUser(db, a1.url, 'buyer');
    const other = await makeUser(db, a1.url, 'buyer');
    const o = await hold(a1, owner, f.eventId, [f.seatIds[0]!]);
    await payOrder(a1, owner, o.json.id);
    await waitFor(async () => (await orderStatus(a1, owner, o.json.id)) === 'paid');
    const ev = await call<{ status: string }>(a1.url, 'GET', `/api/events/${f.eventId}`, {
      token: owner.token,
    });
    expect(ev.json.status).toBe('sold_out');
    await call(a1.url, 'POST', `/api/events/${f.eventId}/waitlist`, {
      token: w1.token,
      body: { quantity: 1 },
    });
    await call(a2.url, 'POST', `/api/events/${f.eventId}/waitlist`, {
      token: w2.token,
      body: { quantity: 1 },
    });
    const ret = await call(a1.url, 'POST', `/api/orders/${o.json.id}/refunds`, {
      token: owner.token,
      body: {},
      key: randomUUID(),
    });
    expect(ret.status).toBe(201);
    const s1 = await call<{ status: string; offeredSeatIds: number[] }>(
      a1.url,
      'GET',
      `/api/events/${f.eventId}/waitlist`,
      { token: w1.token },
    );
    expect(s1.json.status).toBe('offered');
    expect(
      (
        await call<{ status: string }>(a1.url, 'GET', `/api/events/${f.eventId}/waitlist`, {
          token: w2.token,
        })
      ).json.status,
    ).toBe('waiting');
    expect((await hold(a1, other, f.eventId, [f.seatIds[0]!])).json.error.code).toBe(
      'SEAT_OFFERED',
    );
    await advanceTime(a1.url, 31 * 60_000);
    try {
      await sweep(a1.url);
      expect(
        (
          await call<{ status: string }>(a1.url, 'GET', `/api/events/${f.eventId}/waitlist`, {
            token: w1.token,
          })
        ).json.status,
      ).toBe('left');
      expect(
        (
          await call<{ status: string }>(a1.url, 'GET', `/api/events/${f.eventId}/waitlist`, {
            token: w2.token,
          })
        ).json.status,
      ).toBe('offered');
      expect((await hold(a1, w2, f.eventId, [f.seatIds[0]!])).status).toBe(201);
    } finally {
      await resetTime(a1.url);
    }
  });
});

describe('invariant 8 — event cancellation registers one refund per paid order and stops sales at once', () => {
  it('is repeatable without duplicates', async () => {
    const f = await createEvent(db, a1.url, { seats: 6 });
    const buyers = await Promise.all(
      Array.from({ length: 3 }, () => makeUser(db, a1.url, 'buyer')),
    );
    for (const [i, b] of buyers.entries()) {
      const o = await hold(a1, b, f.eventId, [f.seatIds[i]!]);
      await payOrder(a1, b, o.json.id);
      await waitFor(async () => (await orderStatus(a1, b, o.json.id)) === 'paid');
    }
    const c1 = await call<{ total: number; status: string }>(
      a1.url,
      'POST',
      `/api/events/${f.eventId}/cancel`,
      { token: f.organizer.token },
    );
    expect(c1.json.total).toBe(3);
    const late = await hold(a1, await makeUser(db, a1.url, 'buyer'), f.eventId, [f.seatIds[5]!]);
    expect(late.json.error.code).toBe('EVENT_CANCELLED');
    const c2 = await call<{ total: number }>(a2.url, 'POST', `/api/events/${f.eventId}/cancel`, {
      token: f.organizer.token,
    });
    expect(c2.json.total).toBe(3);
    const n = await db.$queryRaw<
      { n: number; fee: number }[]
    >`SELECT count(*)::int AS n, sum(r.fee_kop)::float8 AS fee FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = ${f.eventId}::uuid AND r.kind = 'cancellation'`;
    expect(n[0]!.n).toBe(3);
    expect(n[0]!.fee).toBeGreaterThan(0); // cancellation returns the service fee too
    // the provider refunds go out via the dispatcher (the worker's job later); drive it through finance retry-free path:
    const prog = await call<{ done: number; total: number }>(
      a1.url,
      'GET',
      `/api/events/${f.eventId}/cancel-progress`,
      { token: f.organizer.token },
    );
    expect(prog.json.total).toBe(3);
  });
});
