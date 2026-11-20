import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSWORD = process.env['SEED_PASSWORD'] ?? 'Passw0rd!';

async function apiLogin(
  request: APIRequestContext,
  email: string,
): Promise<{ authorization: string }> {
  const r = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(r.status()).toBe(200);
  const { token } = (await r.json()) as { token: string };
  return { authorization: `Bearer ${token}` };
}

async function uiLogin(page: Page, email: string): Promise<void> {
  await page.goto('/uk/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
}

async function bigEventId(request: APIRequestContext): Promise<string> {
  const r = await request.get('/api/events?q=Big%20Arena');
  const body = (await r.json()) as { items: { id: string; title: string }[] };
  const e = body.items.find((i) => i.title === 'Big Arena Show');
  expect(e).toBeDefined();
  return e?.id ?? '';
}

test('role logins land on their home pages (two browser contexts)', async ({ browser }) => {
  const buyerCtx = await browser.newContext();
  const orgCtx = await browser.newContext();
  const buyer = await buyerCtx.newPage();
  const org = await orgCtx.newPage();
  await Promise.all([uiLogin(buyer, 'buyer2@example.com'), uiLogin(org, 'organizer1@example.com')]);
  await expect(org).toHaveURL(/\/organizer/);
  await expect(buyer).not.toHaveURL(/\/login/);
  await buyerCtx.close();
  await orgCtx.close();
});

test('search page lists seeded events and the hall map renders for the 10k-seat event', async ({
  page,
  request,
}) => {
  await page.goto('/uk');
  await expect(page.locator('a[href*="/events/"]').first()).toBeVisible();
  const id = await bigEventId(request);
  await page.goto(`/uk/events/${id}`);
  await expect(page.locator('canvas, svg').first()).toBeVisible();
});

test('a seat held by buyer A cannot be held by buyer B (through either api instance)', async ({
  request,
}) => {
  const id = await bigEventId(request);
  const a = await apiLogin(request, 'buyer2@example.com');
  const b = await apiLogin(request, 'buyer3@example.com');
  const map = (await (await request.get(`/api/events/${id}/map`)).json()) as {
    seats: { ids: number[]; state: number[] };
  };
  const free = map.seats.state.findIndex((s) => s === 0);
  expect(free).toBeGreaterThanOrEqual(0);
  const seat = map.seats.ids[free];
  const hold = await request.post('/api/holds', {
    headers: { ...a, 'idempotency-key': `e2e-${randomUUID()}` },
    data: { eventId: id, seatIds: [seat], zones: [] },
  });
  expect(hold.status()).toBe(201);
  const order = (await hold.json()) as { id: string };

  const second = await request.post('/api/holds', {
    headers: { ...b, 'idempotency-key': `e2e-${randomUUID()}` },
    data: { eventId: id, seatIds: [seat], zones: [] },
  });
  expect(second.status()).toBe(409); // seat already held by another buyer, through either api instance

  expect(order.id).toBeTruthy();
});

test('controller scan rejects an invalid QR with a coded error', async ({ request }) => {
  const c = await apiLogin(request, 'controller1@example.com');
  const r = await request.post('/api/scan', {
    headers: c,
    data: { eventId: await bigEventId(request), code: 'invalid', gate: 'A' },
  });
  expect(r.status()).toBeGreaterThanOrEqual(400);
  expect(r.status()).toBeLessThan(500);
});
