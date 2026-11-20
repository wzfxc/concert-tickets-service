import { describe, expect, it } from 'vitest';

/**
 * Perf budgets from plan.md, asserted against the compose stack with the full seed (through nginx).
 * Run: `docker compose up -d --build` (wait for seed), then `pnpm --filter @tickets/tests test:perf`.
 */
const BASE = process.env['STACK_URL'] || 'http://localhost:8080';
const PASSWORD = process.env['SEED_PASSWORD'] ?? 'Passw0rd!';

async function login(email: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

async function p95(path: string, token?: string): Promise<number> {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const times: number[] = [];
  for (let i = 0; i < 31; i++) {
    const t = performance.now();
    const r = await fetch(`${BASE}${path}`, { headers });
    await r.arrayBuffer();
    expect(r.status, path).toBe(200);
    if (i > 0) times.push(performance.now() - t); // first request is warm-up
  }
  times.sort((a, b) => a - b);
  return times[Math.ceil(times.length * 0.95) - 1] ?? Infinity;
}

async function bigEventId(): Promise<string> {
  const body = (await (await fetch(`${BASE}/api/events?q=Big%20Arena`)).json()) as {
    items: { id: string; title: string }[];
  };
  const big = body.items.find((e) => e.title === 'Big Arena Show');
  expect(big).toBeDefined();
  return big?.id ?? '';
}

describe('perf budgets on the full seed', () => {
  it('event search < 200 ms', async () => {
    const ms = await p95(
      '/api/events?q=Tour&city=Kyiv&category=concert&sort=price&order=asc&page=1',
    );
    expect(ms).toBeLessThan(200);
  });

  it('10k-seat hall map < 200 ms', async () => {
    const buyer = await login('buyer2@example.com');
    const ms = await p95(`/api/events/${await bigEventId()}/map`, buyer);
    expect(ms).toBeLessThan(200);
  });

  it('organizer sales report (90 days) < 500 ms', async () => {
    const token = await login('organizer1@example.com');
    const ms = await p95(`/api/organizer/events/${await bigEventId()}/sales`, token);
    expect(ms).toBeLessThan(500);
  });

  it('finance 90-day report < 500 ms', async () => {
    const token = await login('finance1@example.com');
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(new Date().getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const ms = await p95(`/api/finance/report?from=${from}&to=${to}`, token);
    expect(ms).toBeLessThan(500);
  });
});
