import { createHmac, timingSafeEqual } from 'node:crypto';

/** Server-side only (node:crypto): exported as `@tickets/shared/qr`, not from the web-facing index. */
const sign = (secret: string, ticketId: string, version: number): string =>
  createHmac('sha256', secret).update(`${ticketId}.${version}`).digest('base64url');

/** QR payload: `<ticketId>.<version>.<base64url(HMAC-SHA256(secret, "<ticketId>.<version>"))>`. */
export function signQr(secret: string, ticketId: string, version: number): string {
  return `${ticketId}.${version}.${sign(secret, ticketId, version)}`;
}

export type QrParse =
  { ok: true; ticketId: string; version: number } | { ok: false; code: 'INVALID_SIGNATURE' };

export function verifyQr(secret: string, payload: string): QrParse {
  const m = /^([0-9a-f-]{36})\.(\d{1,9})\.([A-Za-z0-9_-]{43})$/.exec(payload.trim());
  if (!m) return { ok: false, code: 'INVALID_SIGNATURE' };
  const ticketId = m[1] as string;
  const version = Number(m[2]);
  const expected = Buffer.from(sign(secret, ticketId, version));
  const given = Buffer.from(m[3] as string);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, code: 'INVALID_SIGNATURE' };
  }
  return { ok: true, ticketId, version };
}
