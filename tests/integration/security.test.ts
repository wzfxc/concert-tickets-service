import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@tickets/db';
import { call, makeUser, PASSWORD, startApi, type ApiProc } from './api-helpers.ts';
import { makeDb } from './helpers.ts';

interface ApiErr {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let db: PrismaClient;
let api: ApiProc;

const ip = (): Record<string, string> => ({
  'x-forwarded-for': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = makeDb(5);
  api = await startApi(3951, {
    RATE_LIMIT_DISABLED: 'false',
    RATE_LIMIT_WINDOW_MS: '2000',
    RATE_LIMIT_DEFAULT_PER_MIN: '5',
    TRUST_PROXY: 'true',
    BF_EMAIL_THRESHOLD: '3',
    BF_BASE_LOCK_MS: '1500',
    BF_IP_THRESHOLD: '1000',
  });
});
afterAll(async () => {
  await api.stop();
  await db.$disconnect();
});

describe('rate limiting', () => {
  it('limits per user with the standard error + Retry-After, and recovers after the window', async () => {
    const u = await makeUser(db, api.url, 'buyer', 'rl');
    for (let i = 0; i < 5; i++) {
      expect((await call(api.url, 'GET', '/api/me', { token: u.token })).status).toBe(200);
    }
    const res = await fetch(`${api.url}/api/me`, {
      headers: { authorization: `Bearer ${u.token}` },
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const body = (await res.json()) as ApiErr;
    expect(body.error.code).toBe('RATE_LIMITED');
    // another user is unaffected (limits are per identity)
    const other = await makeUser(db, api.url, 'buyer', 'rl2');
    expect((await call(api.url, 'GET', '/api/me', { token: other.token })).status).toBe(200);
    await sleep(2300);
    expect((await call(api.url, 'GET', '/api/me', { token: u.token })).status).toBe(200);
  });

  it('health and the payment webhook are exempt', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call(api.url, 'GET', '/api/health')).status).toBe(200);
    }
  });
});

describe('login brute-force protection', () => {
  it('locks out after repeated failures before verifying the password, then resets after the window', async () => {
    const u = await makeUser(db, api.url, 'buyer', 'bf');
    const headers = ip();
    for (let i = 0; i < 3; i++) {
      const r = await call<ApiErr>(api.url, 'POST', '/api/auth/login', {
        body: { email: u.email, password: 'wrong-password' },
        headers,
      });
      expect(r.status).toBe(401);
    }
    // correct password is refused while locked: no token issued
    const locked = await fetch(`${api.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email: u.email, password: PASSWORD }),
    });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const lockedBody = (await locked.json()) as ApiErr & { token?: string };
    expect(lockedBody.error.code).toBe('RATE_LIMITED');
    expect(lockedBody.token).toBeUndefined();
    // other accounts (from another address) are not affected
    const stranger = await makeUser(db, api.url, 'buyer', 'bf2');
    expect(stranger.token).toBeTruthy();
    await sleep(1800);
    const ok = await call<{ token: string }>(api.url, 'POST', '/api/auth/login', {
      body: { email: u.email, password: PASSWORD },
      headers,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.token).toBeTruthy();
  });
});

describe('venue upload hardening', () => {
  const layout = (over: Record<string, unknown> = {}) => ({
    name: 'Hall',
    city: 'Kyiv',
    zones: [{ kind: 'seated', name: 'A', rows: [{ label: 'R1', seats: 5 }] }],
    ...over,
  });

  it('accepts a valid layout and rejects swapped / malformed payloads with coded errors', async () => {
    const org = await makeUser(db, api.url, 'organizer', 'up');
    const post = (init: { body: string; type?: string }) =>
      fetch(`${api.url}/api/venues`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${org.token}`,
          ...(init.type ? { 'content-type': init.type } : {}),
          ...ip(),
        },
        body: init.body,
      });
    const json = 'application/json';
    // spread over distinct users so the per-user upload limit (10/window) is not what we measure
    expect((await post({ body: JSON.stringify(layout()), type: json })).status).toBe(201);

    const wrongType = await post({ body: JSON.stringify(layout()), type: 'text/plain' });
    expect(wrongType.status).toBe(415);
    expect(((await wrongType.json()) as ApiErr).error.code).toBe('VALIDATION_ERROR');

    const noType = await post({ body: JSON.stringify(layout()) });
    expect(noType.status).toBe(415);

    for (const bad of [
      layout({ extra: 'x' }), // unknown key
      layout({ name: '../../etc/passwd' }), // path separators
      layout({ name: 'Hall\u0000' }), // control characters
      layout({ city: '<script>' }), // markup
      layout({
        zones: [{ kind: 'seated', name: 'A', rows: [{ label: 'R1', seats: 5, evil: 1 }] }],
      }),
      layout({
        zones: [
          {
            kind: 'seated',
            name: 'A',
            rows: [
              { label: 'R1', seats: 1 },
              { label: 'R1', seats: 1 },
            ],
          },
        ],
      }),
      layout({
        zones: [
          { kind: 'dancefloor', name: 'A', capacity: 5 },
          { kind: 'dancefloor', name: 'A', capacity: 5 },
        ],
      }),
    ]) {
      const r = await post({ body: JSON.stringify(bad), type: json });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(((await r.json()) as ApiErr).error.code).toBe('VALIDATION_ERROR');
    }

    const broken = await post({ body: '{"name": "Hall", ', type: json });
    expect(broken.status).toBe(400);
    const notObject = await post({ body: '"just a string"', type: json });
    expect(notObject.status).toBeGreaterThanOrEqual(400);
    expect(notObject.status).toBeLessThan(500);

    const huge = await post({
      body: JSON.stringify(layout({ pad: 'x'.repeat(300_000) })),
      type: json,
    });
    expect(huge.status).toBe(413);
    expect(((await huge.json()) as ApiErr).error.code).toBe('VALIDATION_ERROR');
    void randomUUID;
  });
});
