import pg from 'pg';
import { describe, expect, it } from 'vitest';

/**
 * Acceptance rows 10/11 at full scale on the seed: cancels `E-CANCEL` (10 000 paid orders) with the payment stub in
 * chaos mode and several workers running, then cancels again. Run against a live stack (api behind nginx + workers):
 *   STACK_URL=http://localhost:8080 PG_URL=postgresql://... pnpm --filter @tickets/tests test:mass-cancel
 * Killing a worker with `kill -9` while it runs is done by the operator (the test only waits for completion).
 */
const BASE = process.env['STACK_URL'] || 'http://localhost:8080';
const PG_URL =
  process.env['PG_URL'] || 'postgresql://tickets:tickets_dev_password@localhost:55432/tickets';
const PASSWORD = process.env['SEED_PASSWORD'] || 'Passw0rd!';

async function api<T>(
  method: string,
  path: string,
  token?: string,
): Promise<{ status: number; json: T }> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, json: (await r.json()) as T };
}

describe('mass cancel of E-CANCEL (10 000 orders) under chaos', () => {
  it(
    'refunds every order exactly once, respects the stub limit, and a repeat cancel is a no-op',
    async () => {
      const db = new pg.Client({ connectionString: PG_URL });
      await db.connect();
      try {
        const login = await fetch(`${BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'organizer1@example.com', password: PASSWORD }),
        });
        const token = ((await login.json()) as { token: string }).token;
        const ev = await db.query<{ id: string }>(`SELECT id FROM events WHERE code = 'E-CANCEL'`);
        const id = ev.rows[0]!.id;
        const paid = Number(
          (
            await db.query(
              `SELECT count(*) FROM orders WHERE event_id = $1 AND status IN ('paid', 'refunded')`,
              [id],
            )
          ).rows[0].count,
        );
        expect(paid).toBeGreaterThanOrEqual(10_000);
        const prior = await db.query(`SELECT 1 FROM cancel_batches WHERE event_id = $1`, [id]);
        // keep the request log of an earlier (interrupted) run so the rate ceiling is checked over the whole cancellation
        if (!prior.rowCount) await db.query(`DELETE FROM stub_request_log`);

        const started = await api<{ status: string; total: number }>(
          'POST',
          `/api/events/${id}/cancel`,
          token,
        );
        expect(started.status).toBe(200);
        // sales stop at once: the event is already cancelled while refunds are still being processed
        const status = await db.query(`SELECT status FROM events WHERE id = $1`, [id]);
        expect(status.rows[0].status).toBe('cancelled');

        let last = { status: 'running', total: 0, done: 0 };
        const deadline = performance.now() + 25 * 60_000;
        while (performance.now() < deadline) {
          last = (await api<typeof last>('GET', `/api/events/${id}/cancel-progress`, token)).json;
          if (last.status === 'done') break;
          await new Promise((r) => setTimeout(r, 5_000));
        }
        expect(last.status).toBe('done');
        expect(last.done).toBe(last.total);

        const refunds = await db.query(
          `SELECT count(*)::int AS n, count(DISTINCT order_id)::int AS orders,
                count(*) FILTER (WHERE r.status = 'done')::int AS ok
         FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1 AND r.kind = 'cancellation'`,
          [id],
        );
        expect(refunds.rows[0].n).toBe(refunds.rows[0].orders); // one refund per order, no duplicates
        expect(refunds.rows[0].ok).toBe(paid);
        const notRefunded = await db.query(
          `SELECT count(*)::int AS n FROM orders WHERE event_id = $1 AND status = 'paid'`,
          [id],
        );
        expect(notRefunded.rows[0].n).toBe(0);

        const peak = await db.query(
          `SELECT max(c)::int AS peak FROM (
           SELECT count(*) AS c FROM stub_request_log WHERE status <> 429 GROUP BY date_trunc('second', at)) s`,
        );
        expect(peak.rows[0].peak).toBeLessThanOrEqual(20);
        const ledger = await db.query(
          `SELECT coalesce(sum(amount_kop), 0)::text AS s FROM ledger_entries`,
        );
        expect(ledger.rows[0].s).toBe('0');

        const again = await api('POST', `/api/events/${id}/cancel`, token);
        expect(again.status).toBe(200);
        const after = await db.query(
          `SELECT count(*)::int AS n FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1`,
          [id],
        );
        expect(after.rows[0].n).toBe(refunds.rows[0].n);
      } finally {
        await db.end();
      }
    },
    30 * 60_000,
  );
});
