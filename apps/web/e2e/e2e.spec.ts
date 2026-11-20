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
  await uiLogin(page, 'buyer3@example.com'); // the hall map endpoint requires a signed-in buyer
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(`/uk/events/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
});

test('a seat held by buyer A cannot be held by buyer B (through either api instance)', async ({
  request,
}) => {
  const id = await bigEventId(request);
  const a = await apiLogin(request, 'buyer2@example.com');
  const b = await apiLogin(request, 'buyer3@example.com');
  const map = (await (await request.get(`/api/events/${id}/map`, { headers: a })).json()) as {
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

test.describe('row 19 — URL state survives reload and browser Back', () => {
  test('search filters and sort live in the URL', async ({ page }) => {
    await page.goto('/uk');
    await page.locator('#q').fill('Tour');
    await page.locator('#city').fill('Kyiv');
    await page.locator('#city').press('Enter');
    await expect(page).toHaveURL(/q=Tour/);
    await expect(page).toHaveURL(/city=Kyiv/);
    await page.locator('#sort').selectOption('price');
    await expect(page).toHaveURL(/sort=price/);
    await page.reload();
    await expect(page.locator('#q')).toHaveValue('Tour');
    await expect(page.locator('#city')).toHaveValue('Kyiv');
    await expect(page.locator('#sort')).toHaveValue('price');
    await page.goBack();
    await expect(page).not.toHaveURL(/sort=price/);
    await expect(page).toHaveURL(/city=Kyiv/);
    await expect(page.locator('#sort')).toHaveValue('date');
  });

  test('10k hall map: reload keeps the map, Back returns to the filtered search', async ({
    page,
    request,
  }) => {
    const id = await bigEventId(request);
    await uiLogin(page, 'buyer3@example.com');
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto('/uk?q=Big%20Arena');
    await page.locator(`a[href*="/events/${id}"]`).first().click();
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
    await page.goBack();
    await expect(page).toHaveURL(/q=Big/);
    await expect(page.locator('#q')).toHaveValue('Big Arena');
  });

  test('finance 90-day report period lives in the URL', async ({ page }) => {
    await uiLogin(page, 'finance1@example.com');
    await expect(page).toHaveURL(/\/finance/);
    await page.goto('/uk/finance?from=2026-08-22&to=2026-11-20');
    await expect(page.locator('#f-from')).toHaveValue('2026-08-22');
    await page.locator('#f-from').fill('2026-10-01');
    await page.locator('#f-from').press('Enter');
    await expect(page).toHaveURL(/from=2026-10-01/);
    await page.reload();
    await expect(page.locator('#f-from')).toHaveValue('2026-10-01');
    await page.goBack();
    await expect(page).toHaveURL(/from=2026-08-22/);
    await expect(page.locator('#f-from')).toHaveValue('2026-08-22');
  });
});

test.describe('row 20 — uk / en / pl money, dates and plurals', () => {
  const cases = [
    { l: 'uk', intl: 'uk-UA', found: /Знайдено: 1 подія/ },
    { l: 'en', intl: 'en-US', found: /Found: 1 event(?!s)/ },
    { l: 'pl', intl: 'pl-PL', found: /Znaleziono: 1 wydarzenie/ },
  ] as const;
  for (const c of cases) {
    test(`/${c.l}: lang, currency, date and plural`, async ({ page, request }) => {
      const res = await request.get('/api/events?q=Big%20Arena');
      const big = (
        (await res.json()) as { items: { title: string; minPriceKop: number }[] }
      ).items.find((e) => e.title === 'Big Arena Show');
      expect(big).toBeDefined();
      await page.goto(`/${c.l}?q=Big%20Arena`);
      await expect(page.locator('html')).toHaveAttribute('lang', c.l);
      const body = page.locator('body');
      await expect(body).toContainText(c.found);
      const expectedMoney = new Intl.NumberFormat(c.intl, {
        style: 'currency',
        currency: 'UAH',
        currencyDisplay: 'narrowSymbol',
      })
        .format((big?.minPriceKop ?? 0) / 100)
        .replace(/[\u00a0\u202f]/g, ' ');
      const text = (await body.innerText()).replace(/[\u00a0\u202f]/g, ' ');
      expect(text).toContain(expectedMoney);
      const month = c.l === 'en' ? /\b[A-Z][a-z]{2} \d{1,2}, 20\d\d/ : /\d{1,2} \p{L}+\.? 20\d\d/u;
      expect(text).toMatch(month);
    });
  }
});
