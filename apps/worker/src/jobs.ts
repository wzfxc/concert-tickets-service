import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import { postLedger, type PrismaClient } from '@tickets/db';
import { dispatchRefund, type StubClient } from '@tickets/domain';
import { calcPayout, PAYOUT_DELAY_MS } from '@tickets/shared';
import { signQr } from '@tickets/shared/qr';
import { config } from './config.js';

const MAX_EMAIL_ATTEMPTS = 5;
const EVENT_FALLBACK_LENGTH = "interval '3 hours'";

// ───────────────────────── due-work queries (Postgres is the source of truth) ─────────────────────────

export function dueRefunds(db: PrismaClient): Promise<{ id: string; attempts: number }[]> {
  return db.$queryRaw`
    SELECT id, attempts FROM refunds
    WHERE status = 'pending' AND (locked_until IS NULL OR locked_until <= app_now())
    ORDER BY created_at LIMIT 300`;
}

export function dueEmails(db: PrismaClient): Promise<{ id: number; attempts: number }[]> {
  return db.$queryRaw`
    SELECT id::float8 AS id, attempts FROM email_outbox
    WHERE status = 'pending' AND (locked_until IS NULL OR locked_until <= now()) ORDER BY id LIMIT 200`;
}

export function duePayouts(db: PrismaClient): Promise<{ id: string }[]> {
  return db.$queryRaw`
    SELECT id FROM events
    WHERE status = 'finished'
      AND COALESCE(ends_at, starts_at + interval '3 hours') + make_interval(secs => ${PAYOUT_DELAY_MS / 1000}::float8) <= app_now()
    LIMIT 50`;
}

/** Events whose end has passed become `finished` (server clock, so tests can advance time). */
export async function finishEvents(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    UPDATE events SET status = 'finished'
    WHERE status IN ('on_sale', 'sold_out', 'rescheduled')
      AND COALESCE(ends_at, starts_at + ${EVENT_FALLBACK_LENGTH}) <= app_now()`);
}

// ───────────────────────── refunds ─────────────────────────

/** Sends one refund to the provider; safe to run twice (lease + provider idempotency on the refund id). */
export function handleRefund(db: PrismaClient, stub: StubClient, refundId: string) {
  return dispatchRefund(db, stub, refundId);
}

// ───────────────────────── e-mail (+ PDF with QR) ─────────────────────────

const transport = nodemailer.createTransport({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: false,
  ignoreTLS: true,
});

async function ticketsPdf(db: PrismaClient, orderId: string): Promise<Buffer> {
  const rows = await db.$queryRaw<
    {
      id: string;
      qr_version: number;
      title: string;
      starts_at: Date;
      zone: string;
      row_label: string | null;
      seat_number: number | null;
    }[]
  >`SELECT t.id, t.qr_version, e.title, e.starts_at, z.name AS zone, s.row_label, s.seat_number
    FROM tickets t JOIN order_items oi ON oi.id = t.order_item_id JOIN events e ON e.id = t.event_id
    JOIN zones z ON z.id = t.zone_id LEFT JOIN seats s ON s.id = t.seat_id
    WHERE oi.order_id = ${orderId}::uuid ORDER BY t.id`;
  const doc = new PDFDocument({ size: 'A5', margin: 36 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );
  for (const [i, t] of rows.entries()) {
    if (i > 0) doc.addPage();
    doc.fontSize(20).text(t.title);
    doc.moveDown(0.5).fontSize(12).text(t.starts_at.toISOString());
    doc.text(
      t.row_label ? `${t.zone}, row ${t.row_label}, seat ${t.seat_number}` : `${t.zone} (standing)`,
    );
    const png = await QRCode.toBuffer(signQr(config.qrSecret, t.id, t.qr_version), {
      width: 220,
      margin: 1,
    });
    doc.moveDown().image(png, { width: 220 });
    doc.fontSize(8).text(`Ticket ${t.id}`);
  }
  if (rows.length === 0) doc.text('No tickets');
  doc.end();
  return done;
}

/**
 * Sends one queued mail exactly once: the row is leased, the Message-ID is derived from the dedup key (the mail stub
 * drops a repeated Message-ID, covering a crash between SMTP delivery and marking the row sent), failures back off
 * and end up in failed_jobs after the last attempt.
 */
export async function handleEmail(db: PrismaClient, id: number): Promise<void> {
  const claimed = await db.$queryRaw<
    { dedup_key: string; to_email: string; subject: string; body: string; attempts: number }[]
  >`
    UPDATE email_outbox SET locked_until = now() + interval '60 seconds', attempts = attempts + 1
    WHERE id = ${id}::bigint AND status = 'pending' AND (locked_until IS NULL OR locked_until <= now())
    RETURNING dedup_key, to_email, subject, body, attempts`;
  const m = claimed[0];
  if (!m) return;
  try {
    const orderId = m.dedup_key.startsWith('tickets:')
      ? m.dedup_key.slice('tickets:'.length)
      : null;
    await transport.sendMail({
      from: config.mailFrom,
      to: m.to_email,
      subject: m.subject,
      text: m.body,
      messageId: `<${m.dedup_key}@tickets.local>`,
      ...(orderId
        ? { attachments: [{ filename: 'tickets.pdf', content: await ticketsPdf(db, orderId) }] }
        : {}),
    });
    await db.$executeRaw`UPDATE email_outbox SET status = 'sent', sent_at = now(), locked_until = NULL WHERE id = ${id}::bigint`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (m.attempts >= MAX_EMAIL_ATTEMPTS) {
      await db.$executeRaw`UPDATE email_outbox SET status = 'failed', locked_until = NULL WHERE id = ${id}::bigint`;
      await db.$executeRaw`
        INSERT INTO failed_jobs (queue, job_key, payload, error, attempts)
        VALUES ('email', ${m.dedup_key}, ${JSON.stringify({ id })}::jsonb, ${msg.slice(0, 500)}, ${m.attempts})
        ON CONFLICT (queue, job_key) DO UPDATE SET error = EXCLUDED.error, failed_at = now(), retried_at = NULL`;
    } else {
      const delay = 2 ** m.attempts;
      await db.$executeRaw`UPDATE email_outbox SET locked_until = now() + make_interval(secs => ${delay}::float8) WHERE id = ${id}::bigint`;
    }
  }
}

// ───────────────────────── payout ─────────────────────────

/**
 * Pays the organizer 3 days after the event: payout = sales − refunds − commission (8% of net, rounded in the
 * organizer's favour). Two idempotent ledger postings (settlement, cash out) + `paid_out`, all in one transaction.
 * Postponed while any refund of the event is still in flight, so refunds can never be missed.
 */
export async function handlePayout(db: PrismaClient, eventId: string): Promise<void> {
  await db.$transaction(
    async (tx) => {
      const ev = await tx.$queryRaw<{ status: string; organizer_id: string }[]>`
        SELECT status::text AS status, organizer_id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`;
      if (ev[0]?.status !== 'finished') return;
      const open = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM refunds r JOIN orders o ON o.id = r.order_id
        WHERE o.event_id = ${eventId}::uuid AND r.status IN ('pending', 'sent')`;
      if (open[0]!.n > 0) return;
      const sums = await tx.$queryRaw<{ sales: number; refunds: number }[]>`
        SELECT COALESCE((SELECT sum(subtotal_kop - discount_kop) FROM orders WHERE event_id = ${eventId}::uuid AND paid_kop > 0), 0)::float8 AS sales,
               COALESCE((SELECT sum(r.amount_kop - r.fee_kop) FROM refunds r JOIN orders o ON o.id = r.order_id
                         WHERE o.event_id = ${eventId}::uuid AND r.status = 'done'), 0)::float8 AS refunds`;
      const { sales, refunds } = sums[0]!;
      const org = ev[0].organizer_id;
      if (sales > 0) {
        const { commissionKop, payoutKop } = calcPayout(sales, refunds);
        const settle = [
          { account: 'ticket_revenue_liability', organizer: org, amount: sales },
          { account: 'refunds', organizer: org, amount: -refunds },
          { account: 'commission_revenue', organizer: org, amount: -commissionKop },
          { account: 'organizer_payable', organizer: org, amount: -payoutKop },
        ].filter((l) => l.amount !== 0);
        await postLedger(tx, 'payout_settle', eventId, settle);
        if (payoutKop > 0) {
          await postLedger(tx, 'payout_paid', eventId, [
            { account: 'organizer_payable', organizer: org, amount: payoutKop },
            { account: 'provider_clearing', amount: -payoutKop },
          ]);
        }
      }
      await tx.$executeRaw`UPDATE events SET status = 'paid_out' WHERE id = ${eventId}::uuid`;
    },
    { maxWait: 30_000, timeout: 60_000 },
  );
}
