import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '@tickets/shared/password';
import { signQr } from '@tickets/shared/qr';
import type { PrismaClient } from '@tickets/db';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const SECRETS = {
  JWT_SECRET: 'test-jwt-secret',
  QR_SIGNING_SECRET: 'test-qr-secret',
  PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret',
};
export const PASSWORD = 'Passw0rd!';

export interface ApiProc {
  url: string;
  port: number;
  proc: ChildProcess;
  stop(): Promise<void>;
}

/** Starts the built api (`apps/api/dist`) as a real process, like compose does (two of these = api1/api2). */
export async function startApi(port: number, env: Record<string, string> = {}): Promise<ApiProc> {
  const dbUrl = process.env['TEST_DATABASE_URL'];
  if (!dbUrl) throw new Error('TEST_DATABASE_URL not set by global setup');
  const proc = spawn(process.execPath, ['dist/main.js'], {
    cwd: path.join(ROOT, 'apps/api'),
    env: {
      ...process.env,
      ...SECRETS,
      DATABASE_URL: dbUrl,
      REDIS_URL: process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379',
      PORT: String(port),
      INSTANCE_ID: `api${port}`,
      ENABLE_TEST_CONTROLS: 'true',
      RATE_LIMIT_DISABLED: 'true', // security.test.ts starts its own instances with limits on
      QUEUE_MAX_SELECTORS: '2',
      DB_POOL_SIZE: '30',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (log += d.toString()));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`api exited early:\n${log}`);
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
    if (i === 99) throw new Error(`api did not start:\n${log}`);
  }
  return {
    url,
    port,
    proc,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGKILL');
      }),
  };
}

export interface Res<T = Record<string, unknown>> {
  status: number;
  json: T;
}

export async function call<T = Record<string, unknown>>(
  base: string,
  method: string,
  p: string,
  opts: { token?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Promise<Res<T>> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.key ? { 'idempotency-key': opts.key } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json: json as T };
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

let passwordHash: string | undefined;

/** Inserts a user straight into Postgres (like the seed does) and logs in over HTTP. */
export async function makeUser(
  db: PrismaClient,
  api: string,
  role: 'buyer' | 'organizer' | 'controller' | 'finance',
  label: string = role,
): Promise<TestUser> {
  passwordHash ??= await hashPassword(PASSWORD);
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO users (email, password_hash, name, role) VALUES (${email}, ${passwordHash}, ${label}, ${role}::user_role) RETURNING id`;
  const res = await call<{ token: string }>(api, 'POST', '/api/auth/login', {
    body: { email, password: PASSWORD },
  });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.json)}`);
  return { id: rows[0]!.id, email, token: res.json.token };
}

export const qrFor = (ticketId: string, version: number): string =>
  signQr(SECRETS.QR_SIGNING_SECRET, ticketId, version);

export async function advanceTime(api: string, ms: number): Promise<void> {
  const r = await call(api, 'POST', '/__test/time/advance', { body: { ms } });
  if (r.status !== 200) throw new Error('time advance failed');
}
export async function resetTime(api: string): Promise<void> {
  await call(api, 'POST', '/__test/time/reset');
}
export async function sweep(api: string): Promise<void> {
  await call(api, 'POST', '/__test/sweep');
}

export interface EventFixture {
  organizer: TestUser;
  venueId: string;
  zoneIds: Record<string, string>;
  eventId: string;
  seatIds: number[];
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
  stepMs = 150,
): Promise<T> {
  const start = new Date().getTime();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (new Date().getTime() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Organizer uploads a layout (rows x seats + dancefloor), prices it and publishes the event via the real API. */
export async function createEvent(
  db: PrismaClient,
  api: string,
  opts: {
    seats?: number;
    startsInDays?: number;
    dancefloor?: number;
    limit?: number;
    salesStart?: Date;
    queue?: boolean;
    organizer?: TestUser;
  } = {},
): Promise<EventFixture> {
  const organizer = opts.organizer ?? (await makeUser(db, api, 'organizer'));
  const seats = opts.seats ?? 6;
  const layout = {
    name: 'Hall',
    city: 'Kyiv',
    zones: [
      { kind: 'seated', name: 'Parterre', rows: [{ label: 'A', seats }] },
      ...(opts.dancefloor
        ? [{ kind: 'dancefloor', name: 'Floor', capacity: opts.dancefloor }]
        : []),
    ],
  };
  const venue = await call<{ id: string; zones: { id: string; name: string }[] }>(
    api,
    'POST',
    '/api/venues',
    { token: organizer.token, body: layout },
  );
  if (venue.status !== 201) throw new Error(`venue: ${JSON.stringify(venue.json)}`);
  const zoneIds = Object.fromEntries(venue.json.zones.map((z) => [z.name, z.id]));
  const startsAt = new Date(
    new Date().getTime() + (opts.startsInDays ?? 30) * 86_400_000,
  ).toISOString();
  const ev = await call<{ id: string }>(api, 'POST', '/api/events', {
    token: organizer.token,
    body: {
      title: `Concert ${randomUUID().slice(0, 6)}`,
      category: 'concert',
      venueId: venue.json.id,
      startsAt,
      perUserLimit: opts.limit ?? 6,
      ...(opts.salesStart ? { salesStart: opts.salesStart.toISOString() } : {}),
    },
  });
  if (ev.status !== 201) throw new Error(`event: ${JSON.stringify(ev.json)}`);
  const zonePrices = [
    { zoneId: zoneIds['Parterre']!, priceKop: 100_000 },
    ...(opts.dancefloor ? [{ zoneId: zoneIds['Floor']!, priceKop: 50_000 }] : []),
  ];
  const pr = await call(api, 'PUT', `/api/events/${ev.json.id}/prices`, {
    token: organizer.token,
    body: { zonePrices },
  });
  if (pr.status !== 200) throw new Error(`prices: ${JSON.stringify(pr.json)}`);
  if (opts.queue)
    await call(api, 'PATCH', `/api/events/${ev.json.id}/settings`, {
      token: organizer.token,
      body: { queueEnabled: true },
    });
  const pub = await call(api, 'POST', `/api/events/${ev.json.id}/publish`, {
    token: organizer.token,
  });
  if (pub.status !== 200) throw new Error(`publish: ${JSON.stringify(pub.json)}`);
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT s.id::float8 AS id FROM seats s JOIN events e ON e.venue_id = s.venue_id WHERE e.id = ${ev.json.id}::uuid ORDER BY s.id`;
  return {
    organizer,
    venueId: venue.json.id,
    zoneIds,
    eventId: ev.json.id,
    seatIds: rows.map((r) => r.id),
  };
}

export interface Proc {
  proc: ChildProcess;
  stop(): Promise<void>;
  kill9(): Promise<void>;
}

function wrap(proc: ChildProcess): Proc {
  const kill = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGKILL');
    });
  return { proc, stop: kill, kill9: kill };
}

/** Starts the built worker (apps/worker/dist) as a real process; `kill9()` is the SIGKILL used by the crash tests. */
export function startWorker(opts: { apiUrl: string; mail: { smtp: number }; port: number }): Proc {
  const proc = spawn(process.execPath, ['dist/main.js'], {
    cwd: path.join(ROOT, 'apps/worker'),
    env: {
      ...process.env,
      ...SECRETS,
      DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
      REDIS_URL: process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379',
      STUB_BASE_URL: opts.apiUrl,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(opts.mail.smtp),
      PORT: String(opts.port),
      WORKER_TICK_MS: '500',
      RECONCILE_INTERVAL_MS: '3000',
      QUEUE_MAX_SELECTORS: '2',
    },
    stdio: 'ignore',
  });
  return wrap(proc);
}

export function startMailstub(smtp: number, http: number): Proc {
  const proc = spawn(process.execPath, ['dist/main.js'], {
    cwd: path.join(ROOT, 'apps/mailstub'),
    env: { ...process.env, SMTP_PORT: String(smtp), HTTP_PORT: String(http) },
    stdio: 'ignore',
  });
  return wrap(proc);
}

export async function mails(
  http: number,
  to: string,
): Promise<{ subject: string; attachments: { filename: string }[] }[]> {
  try {
    const r = await fetch(`http://127.0.0.1:${http}/api/messages?to=${encodeURIComponent(to)}`);
    return (await r.json()) as { subject: string; attachments: { filename: string }[] }[];
  } catch {
    return []; // mail stub still starting
  }
}
