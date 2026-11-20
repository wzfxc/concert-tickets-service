import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@tickets/db';
import { hashPassword } from '@tickets/shared/password';
import { call, createEvent, PASSWORD, startApi, type ApiProc } from './api-helpers.ts';
import { makeDb } from './helpers.ts';

let db: PrismaClient;
let a1: ApiProc;
let a2: ApiProc;

beforeAll(async () => {
  db = makeDb(10);
  // spec limits: 200 simultaneous seat selectors
  a1 = await startApi(3961, { QUEUE_MAX_SELECTORS: '200' });
  a2 = await startApi(3962, { QUEUE_MAX_SELECTORS: '200' });
});
afterAll(async () => {
  await a1.stop();
  await a2.stop();
  await db.$disconnect();
});

describe('invariant 10 at spec scale — 1000 users entering the queue across both api instances', () => {
  it('admits exactly 200, queues 800 in a gap-free order, and a reload keeps the position', async () => {
    const hash = await hashPassword(PASSWORD);
    const tag = Math.random().toString(36).slice(2, 8);
    await db.$executeRaw`
      INSERT INTO users (email, password_hash, name, role)
      SELECT 'q' || ${tag} || '-' || n || '@example.test', ${hash}, 'Q' || n, 'buyer' FROM generate_series(1, 1000) n`;
    const f = await createEvent(db, a1.url, { seats: 300, queue: true });

    const tokens: string[] = [];
    for (let i = 1; i <= 1000; i += 50) {
      const batch = await Promise.all(
        Array.from({ length: 50 }, (_, k) =>
          call<{ token: string }>(i % 2 ? a1.url : a2.url, 'POST', '/api/auth/login', {
            body: { email: `q${tag}-${i + k}@example.test`, password: PASSWORD },
          }),
        ),
      );
      for (const r of batch) {
        expect(r.status).toBe(200);
        tokens.push(r.json.token);
      }
    }

    // everybody joins at once, alternating between the two instances
    const joined = await Promise.all(
      tokens.map((token, i) =>
        call<{ status: string; position: number | null }>(
          i % 2 ? a1.url : a2.url,
          'POST',
          `/api/events/${f.eventId}/queue`,
          { token },
        ),
      ),
    );
    expect(joined.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const admitted = joined.filter((r) => r.json.status === 'admitted');
    const waiting = joined.filter((r) => r.json.status === 'waiting');
    expect(admitted).toHaveLength(200);
    expect(waiting).toHaveLength(800);
    const positions = waiting.map((r) => r.json.position as number).sort((x, y) => x - y);
    expect(positions).toEqual(Array.from({ length: 800 }, (_, k) => k + 1));

    const active = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM queue_entries WHERE event_id = ${f.eventId}::uuid AND status = 'admitted'`;
    expect(active[0]?.n).toBe(200);

    // reload / second tab on the *other* instance keeps the place
    const idx = joined.findIndex((r) => r.json.position === 400);
    const again = await call<{ status: string; position: number | null }>(
      idx % 2 ? a2.url : a1.url,
      'GET',
      `/api/events/${f.eventId}/queue`,
      { token: tokens[idx]! },
    );
    expect(again.json.status).toBe('waiting');
    expect(again.json.position).toBe(400);
  });
});
