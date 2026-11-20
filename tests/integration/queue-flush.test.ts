import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@tickets/db';
import { call, createEvent, makeUser, startApi, type ApiProc } from './api-helpers.ts';
import { makeDb } from './helpers.ts';

let db: PrismaClient;
let a1: ApiProc;
let a2: ApiProc;

beforeAll(async () => {
  db = makeDb(5);
  a1 = await startApi(3971);
  a2 = await startApi(3972);
});
afterAll(async () => {
  await a1.stop();
  await a2.stop();
  await db.$disconnect();
});

describe('row 12 — the virtual queue survives redis-cli FLUSHALL', () => {
  it('keeps admission order, positions and the admitted set; no duplicates after the flush', async () => {
    const f = await createEvent(db, a1.url, { seats: 10, queue: true });
    const users: Awaited<ReturnType<typeof makeUser>>[] = [];
    for (let i = 0; i < 7; i++) users.push(await makeUser(db, a1.url, 'buyer'));
    const state = async (api: ApiProc) =>
      Promise.all(
        users.map(async (u) => {
          const r = await call<{ status: string; position: number | null }>(
            api.url,
            'GET',
            `/api/events/${f.eventId}/queue`,
            { token: u.token },
          );
          return { status: r.json.status, position: r.json.position };
        }),
      );
    for (const [i, u] of users.entries()) {
      await call(i % 2 ? a1.url : a2.url, 'POST', `/api/events/${f.eventId}/queue`, {
        token: u.token,
      });
    }
    const before = await state(a1);
    expect(before.filter((s) => s.status === 'admitted')).toHaveLength(2); // QUEUE_MAX_SELECTORS=2 in tests
    expect(before.filter((s) => s.status === 'waiting').map((s) => s.position)).toEqual([
      1, 2, 3, 4, 5,
    ]);

    const redis = new Redis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379');
    await redis.flushall();
    await redis.quit();

    expect(await state(a2)).toEqual(before); // read through the other instance
    // joining again (reload / second tab) neither duplicates nor reorders
    for (const u of users)
      await call(a1.url, 'POST', `/api/events/${f.eventId}/queue`, { token: u.token });
    expect(await state(a1)).toEqual(before);
    const rows = await db.$queryRaw<{ n: number; d: number }[]>`
      SELECT count(*)::int AS n, count(DISTINCT user_id)::int AS d FROM queue_entries WHERE event_id = ${f.eventId}::uuid`;
    expect(rows[0]).toEqual({ n: 7, d: 7 });
  });
});
