import { randomUUID } from 'node:crypto';
import {
  dbErrorCode,
  holdZone,
  nextEventSeq,
  postLedger,
  redeemPromo,
  releasePromo,
  setTimeOffset,
  type PrismaClient,
} from '@tickets/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, createOrder, createUser, makeDb, tryHold } from './helpers.ts';

let db: PrismaClient;
beforeAll(() => {
  db = makeDb(60);
});
afterAll(async () => {
  await db.$disconnect();
});

/** Error text of a rejected statement (constraint/trigger name or domain code). */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? `${err.message} ${String(err.cause ?? '')}` : String(err);
  }
  throw new Error('expected the statement to be rejected');
}

describe('invariant 1: a seat is held/sold once', () => {
  it('200 concurrent buyers, 4 seats: exactly 1 wins the contested set, all-or-nothing', async () => {
    const fx = await createFixture(db, 4, 6);
    const buyers = await Promise.all(Array.from({ length: 200 }, () => createUser(db)));
    const results = await Promise.all(buyers.map((b) => tryHold(db, fx.eventId, b, fx.seatIds)));
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === 'SEATS_UNAVAILABLE')).toHaveLength(199);
    const held = await db.seatHold.count({ where: { eventId: fx.eventId, status: 'held' } });
    expect(held).toBe(4); // no partial rows from the 199 losers
  });

  it('overlapping multi-seat requests never leave partial holds', async () => {
    const fx = await createFixture(db, 6, 6);
    const [a, b] = await Promise.all([createUser(db), createUser(db)]);
    const [ra, rb] = await Promise.all([
      tryHold(db, fx.eventId, a, fx.seatIds.slice(0, 4)),
      tryHold(db, fx.eventId, b, fx.seatIds.slice(2, 6)),
    ]);
    expect([ra, rb].filter((r) => r === null)).toHaveLength(1);
    expect(await db.seatHold.count({ where: { eventId: fx.eventId } })).toBe(4);
  });

  it('the partial unique index rejects a second active hold even bypassing hold_seats()', async () => {
    const fx = await createFixture(db, 1);
    const [a, b] = await Promise.all([createUser(db), createUser(db)]);
    const [oa, ob] = await Promise.all([
      createOrder(db, a, fx.eventId),
      createOrder(db, b, fx.eventId),
    ]);
    const seatId = fx.seatIds[0]!;
    await db.seatHold.create({
      data: { eventId: fx.eventId, seatId, orderId: oa, userId: a, expiresAt: new Date() },
    });
    const msg = await failure(
      db.seatHold.create({
        data: { eventId: fx.eventId, seatId, orderId: ob, userId: b, expiresAt: new Date() },
      }),
    );
    expect(msg).toMatch(/seat_holds_active_uq|Unique constraint/);
  });

  it('server clock frees expired holds without any worker (app_now offset)', async () => {
    const fx = await createFixture(db, 1);
    const [a, b] = await Promise.all([createUser(db), createUser(db)]);
    expect(await tryHold(db, fx.eventId, a, fx.seatIds)).toBeNull();
    expect(await tryHold(db, fx.eventId, b, fx.seatIds)).toBe('SEATS_UNAVAILABLE');
    await setTimeOffset(db, 11 * 60 * 1000);
    try {
      expect(await tryHold(db, fx.eventId, b, fx.seatIds)).toBeNull();
    } finally {
      await setTimeOffset(db, 0);
    }
  });
});

describe('invariant 2: limits and promo', () => {
  it('per-user limit 6: 10 parallel holds x2 seats -> exactly 3 succeed', async () => {
    const fx = await createFixture(db, 20, 6);
    const user = await createUser(db);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        tryHold(db, fx.eventId, user, fx.seatIds.slice(i * 2, i * 2 + 2)),
      ),
    );
    expect(results.filter((r) => r === null)).toHaveLength(3);
    expect(results.filter((r) => r === 'PER_USER_LIMIT')).toHaveLength(7);
  });

  it('dancefloor capacity 10, 15 parallel single-ticket holds -> exactly 10', async () => {
    const fx = await createFixture(db, 1, 6);
    const zone = await db.zone.create({
      data: { venueId: fx.venueId, name: 'DF', kind: 'dancefloor', capacity: 10 },
    });
    await db.eventZoneCounter.create({
      data: { eventId: fx.eventId, zoneId: zone.id, capacity: 10 },
    });
    const users = await Promise.all(Array.from({ length: 15 }, () => createUser(db)));
    const results = await Promise.all(
      users.map(async (userId) => {
        const orderId = await createOrder(db, userId, fx.eventId);
        try {
          await holdZone(db, {
            eventId: fx.eventId,
            zoneId: zone.id,
            userId,
            orderId,
            qty: 1,
            ttlSeconds: 600,
          });
          return null;
        } catch (e) {
          return dbErrorCode(e);
        }
      }),
    );
    expect(results.filter((r) => r === null)).toHaveLength(10);
    expect(results.filter((r) => r === 'SEATS_UNAVAILABLE')).toHaveLength(5);
  });

  it('promo limit 100, 150 parallel redemptions -> exactly 100; release gives slots back', async () => {
    const fx = await createFixture(db, 1);
    const promo = await db.promoCode.create({
      data: { eventId: fx.eventId, code: 'P', kind: 'percent', value: 10, usageLimit: 100 },
    });
    const orders = await Promise.all(
      Array.from({ length: 150 }, async () => {
        const u = await createUser(db);
        return { u, o: await createOrder(db, u, fx.eventId) };
      }),
    );
    const wins = await Promise.all(orders.map(({ u, o }) => redeemPromo(db, promo.id, o, u)));
    expect(wins.filter(Boolean)).toHaveLength(100);
    expect((await db.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).used).toBe(100);
    const winners = orders.filter((_, i) => wins[i]).slice(0, 7);
    await Promise.all(winners.map(({ o }) => releasePromo(db, o)));
    expect((await db.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).used).toBe(93);
  });
});

describe('ledger', () => {
  const lines = (a: number) => [
    { account: 'provider_clearing', amount: a },
    { account: 'service_fee_revenue', amount: -a },
  ];

  it('balanced postings succeed and are idempotent per (type, ref)', async () => {
    const ref = randomUUID();
    const first = await postLedger(db, 'payment', ref, lines(500));
    const second = await postLedger(db, 'payment', ref, lines(500));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await db.ledgerTransaction.count({ where: { operationRef: ref } })).toBe(1);
  });

  it('unbalanced transactions are rejected at commit', async () => {
    const bad = [
      { account: 'provider_clearing', amount: 500 },
      { account: 'service_fee_revenue', amount: -400 },
    ];
    const err = await failure(
      db.$transaction((tx) => postLedger(tx, 'payment', randomUUID(), bad)),
    );
    expect(err).toContain('LEDGER_UNBALANCED');
  });

  it('transactions without entries and entry mutation are rejected', async () => {
    expect(
      await failure(
        db.ledgerTransaction.create({ data: { operationType: 'x', operationRef: randomUUID() } }),
      ),
    ).toContain('LEDGER_EMPTY');
    expect(await failure(db.ledgerEntry.updateMany({ data: { amountKop: 1 } }))).toMatch(
      /append-only/,
    );
    expect(await failure(db.ledgerEntry.deleteMany())).toMatch(/append-only/);
  });

  it('global ledger sum is zero and balances equal entry sums', async () => {
    const total = await db.ledgerEntry.aggregate({ _sum: { amountKop: true } });
    expect(total._sum.amountKop ?? 0n).toBe(0n);
    const [row] = await db.$queryRaw<{ s: bigint }[]>`
      SELECT COALESCE(sum(balance_kop), 0)::bigint AS s FROM ledger_balances`;
    expect(row!.s).toBe(0n);
  });
});

describe('invariants 4/6: refund cap', () => {
  it('parallel refunds never exceed paid; loser gets REFUND_EXCEEDS_PAID; same key is rejected by unique', async () => {
    const fx = await createFixture(db, 1);
    const user = await createUser(db);
    const orderId = await createOrder(db, user, fx.eventId);
    await db.order.update({
      where: { id: orderId },
      data: { status: 'paid', paidKop: 10000, totalKop: 10000 },
    });
    const attempt = async (amountKop: number, idempotencyKey: string): Promise<string | null> => {
      try {
        await db.refund.create({ data: { orderId, amountKop, kind: 'user', idempotencyKey } });
        return null;
      } catch (e) {
        return e instanceof Error ? `${e.message} ${String(e.cause ?? '')}` : String(e);
      }
    };
    const results = await Promise.all([
      attempt(6000, 'k1'),
      attempt(6000, 'k2'),
      attempt(4000, 'k3'),
      attempt(10000, 'k4'),
    ]);
    expect(results.filter((r) => r === null).length).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => r !== null).every((r) => r!.includes('REFUND_EXCEEDS_PAID'))).toBe(
      true,
    );
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    const sum = await db.refund.aggregate({ where: { orderId }, _sum: { amountKop: true } });
    expect(order.refundedKop).toBe(sum._sum.amountKop ?? 0n);
    expect(Number(sum._sum.amountKop ?? 0n)).toBeLessThanOrEqual(10000);
    expect(await attempt(1, 'k1')).toMatch(/idempotency_key|REFUND_EXCEEDS_PAID|Unique constraint/);
  });
});

describe('audit and misc constraints', () => {
  it('order_history is append-only', async () => {
    const fx = await createFixture(db, 1);
    const user = await createUser(db);
    const orderId = await createOrder(db, user, fx.eventId);
    await db.orderHistory.create({ data: { orderId, toStatus: 'holding' } });
    expect(await failure(db.orderHistory.updateMany({ data: { note: 'x' } }))).toMatch(
      /append-only/,
    );
    expect(await failure(db.orderHistory.deleteMany())).toMatch(/append-only/);
  });

  it('queue_entries enforces one entry per (event, user)', async () => {
    const fx = await createFixture(db, 1);
    const user = await createUser(db);
    const data = { eventId: fx.eventId, userId: user };
    await db.queueEntry.create({ data });
    expect(await failure(db.queueEntry.create({ data }))).toMatch(
      /queue_entries_event_id_user_id_key|Unique constraint/,
    );
  });

  it('next_event_seq is gap-free and monotonic under concurrency', async () => {
    const fx = await createFixture(db, 1);
    const seqs = await Promise.all(Array.from({ length: 50 }, () => nextEventSeq(db, fx.eventId)));
    const nums = seqs.map(Number).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});
