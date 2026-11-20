/** Business constants from docs/test-assignment-14.md. Money is integer kopecks (UAH minor units). */
export const MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

export const HOLD_TTL_MS = 10 * MS.minute;
export const MAX_SEATS_PER_HOLD = 6;
export const DEFAULT_PER_USER_LIMIT = 6;

export const SERVICE_FEE_PERCENT = 5;
export const SERVICE_FEE_MIN_KOP = 20 * 100; // 20 ₴
export const COMMISSION_PERCENT = 8;

export const REFUND_FULL_BEFORE_MS = 7 * MS.day; // strictly more than 7 days => 100% of price
export const REFUND_HALF_BEFORE_MS = 2 * MS.day; // from 2 to 7 days inclusive => 50%
export const RESCHEDULE_FULL_REFUND_MS = 14 * MS.day;
export const TRANSFER_CUTOFF_MS = MS.hour;
export const WAITLIST_OFFER_TTL_MS = 30 * MS.minute;
export const PAYOUT_DELAY_MS = 3 * MS.day;

export const QUEUE_TRIGGER_CONTENDERS = 500; // queue starts when MORE than this many contend
export const QUEUE_MAX_SELECTORS = 200;
export const QUEUE_ADMIT_TTL_MS = 5 * MS.minute;

export const STUB_MAX_RPS = 20;
export const STUB_CHAOS_503_EVERY = 10;

export const ORDER_STATUSES = [
  'holding',
  'awaiting_payment',
  'paid',
  'expired',
  'partially_refunded',
  'refunded',
] as const;
export const EVENT_STATUSES = [
  'draft',
  'on_sale',
  'sold_out',
  'rescheduled',
  'cancelled',
  'finished',
  'paid_out',
] as const;
export const USER_ROLES = ['buyer', 'organizer', 'controller', 'finance'] as const;
export const LOCALES = ['uk', 'en', 'pl'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type UserRole = (typeof USER_ROLES)[number];
export type Locale = (typeof LOCALES)[number];

/** Machine-readable error codes used by every endpoint (invariant 15). */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'SEATS_UNAVAILABLE',
  'PER_USER_LIMIT',
  'HOLD_EXPIRED',
  'PROMO_EXHAUSTED',
  'PROMO_INVALID',
  'REFUND_EXCEEDS_PAID',
  'REFUND_WINDOW_CLOSED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'EVENT_CANCELLED',
  'EVENT_NOT_ON_SALE',
  'QUEUE_REQUIRED',
  'SEAT_OFFERED',
  'TRANSFER_TOO_LATE',
  'INVALID_SIGNATURE',
  'TICKET_TRANSFERRED',
  'TICKET_REFUNDED',
  'OTHER_EVENT',
  'ALREADY_USED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
