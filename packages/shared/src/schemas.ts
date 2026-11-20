import { z } from 'zod';
import { ERROR_CODES, EVENT_STATUSES, LOCALES, MAX_SEATS_PER_HOLD } from './constants.js';

const kop = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().uuid();
const seatId = z.number().int().positive();

export const ErrorCodeSchema = z.enum(ERROR_CODES);
/** One error shape for every endpoint (invariant 15). */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string(),
  }),
});

export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[\w.:-]+$/);

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

export const EventSearchQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  category: z.string().trim().max(50).optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  priceMin: kop.optional(),
  priceMax: kop.optional(),
  hasSeats: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sort: z.enum(['date', 'price', 'title']).default('date'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const zoneQty = z.object({
  zoneId: uuid,
  quantity: z.number().int().min(1).max(MAX_SEATS_PER_HOLD),
});

/** Hold: seats (≤ 6 tickets total, unique) and/or dancefloor quantity per zone. */
export const CreateHoldSchema = z
  .object({
    eventId: uuid,
    seatIds: z.array(seatId).max(MAX_SEATS_PER_HOLD).default([]),
    zones: z.array(zoneQty).default([]),
  })
  .refine((v) => new Set(v.seatIds).size === v.seatIds.length, {
    message: 'duplicate seats',
    path: ['seatIds'],
  })
  .refine((v) => v.seatIds.length + v.zones.reduce((a, z) => a + z.quantity, 0) >= 1, {
    message: 'select at least one seat',
  })
  .refine(
    (v) => v.seatIds.length + v.zones.reduce((a, z) => a + z.quantity, 0) <= MAX_SEATS_PER_HOLD,
    { message: `at most ${MAX_SEATS_PER_HOLD} tickets per order` },
  );
export const ChangeHoldSchema = z.object({
  addSeatIds: z.array(seatId).max(MAX_SEATS_PER_HOLD).default([]),
  removeSeatIds: z.array(seatId).max(MAX_SEATS_PER_HOLD).default([]),
});

export const ApplyPromoSchema = z.object({ code: z.string().trim().min(1).max(50) });
export const PayOrderSchema = z.object({ orderId: uuid });
export const RefundRequestSchema = z.object({
  ticketIds: z.array(uuid).min(1).max(MAX_SEATS_PER_HOLD).optional(),
});
export const ManualRefundSchema = z.object({
  orderId: uuid,
  amountKop: kop.positive(),
  reason: z.string().trim().min(3).max(500),
});
export const TransferSchema = z.object({ toEmail: z.string().email() });
export const ScanSchema = z.object({
  eventId: uuid,
  code: z.string().min(1).max(300),
  gate: z.string().trim().min(1).max(20),
});
export const JoinQueueSchema = z.object({ eventId: uuid });
export const JoinWaitlistSchema = z.object({
  eventId: uuid,
  quantity: z.number().int().min(1).max(MAX_SEATS_PER_HOLD).default(1),
});

/** Printable text only: control characters, path separators and markup brackets never enter the layout.
 * True when every char is printable and not a path separator or markup bracket. */
function isPrintableSafe(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || ch === '/' || code === 0x5c || ch === '<' || ch === '>')
      return false;
  }
  return true;
}

const safeText = (max: number) =>
  z.string().trim().min(1).max(max).refine(isPrintableSafe, 'contains forbidden characters');

const seatedZone = z
  .object({
    kind: z.literal('seated'),
    name: safeText(100),
    rows: z
      .array(
        z
          .object({
            label: safeText(10),
            seats: z.number().int().min(1).max(500),
            x: z.number().finite().optional(),
            y: z.number().finite().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1000)
      .refine(
        (rows) => new Set(rows.map((r) => r.label)).size === rows.length,
        'duplicate row label',
      ),
  })
  .strict();
const danceFloorZone = z
  .object({
    kind: z.literal('dancefloor'),
    name: safeText(100),
    capacity: z.number().int().min(1).max(100_000),
  })
  .strict();

/** Venue layout JSON uploaded by an organizer: zones, rows, seats, dancefloor with capacity (strict: unknown keys rejected). */
export const VenueLayoutSchema = z
  .object({
    name: safeText(200),
    city: safeText(100),
    zones: z
      .array(z.discriminatedUnion('kind', [seatedZone, danceFloorZone]))
      .min(1)
      .max(100)
      .refine((zs) => new Set(zs.map((z) => z.name)).size === zs.length, 'duplicate zone name'),
  })
  .strict();

export const PriceAssignmentSchema = z.object({
  zonePrices: z.array(z.object({ zoneId: uuid, priceKop: kop.positive() })).default([]),
  seatPrices: z
    .array(z.object({ seatIds: z.array(seatId).min(1), priceKop: kop.positive() }))
    .default([]),
  blockedSeatIds: z.array(seatId).default([]),
});

export const CreateEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(50),
  venueId: uuid,
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(),
  salesStart: z.string().datetime().optional(),
  perUserLimit: z.number().int().min(1).max(100).default(6),
});
export const RescheduleEventSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(),
});

export const CreatePromoSchema = z
  .object({
    eventId: uuid.optional(),
    code: z.string().trim().min(2).max(50),
    kind: z.enum(['percent', 'fixed']),
    value: z.number().int().positive(),
    usageLimit: z.number().int().positive().max(1_000_000),
    validUntil: z.string().datetime().optional(),
  })
  .refine((v) => v.kind !== 'percent' || v.value <= 100, {
    message: 'percent must be 1..100',
    path: ['value'],
  });

export const ReportPeriodSchema = z.object({ from: z.string().date(), to: z.string().date() });
export const LocaleSchema = z.enum(LOCALES);

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(100),
  locale: LocaleSchema.default('uk'),
});
/** Waitlist join: event comes from the path; `zoneId` selects a dancefloor zone (omit for seated tickets). */
export const WaitlistJoinSchema = z.object({
  quantity: z.number().int().min(1).max(MAX_SEATS_PER_HOLD).default(1),
  zoneId: uuid.optional(),
});
export const AssignControllerSchema = z.object({ email: z.string().email() });
export const UpdateEventSettingsSchema = z.object({
  perUserLimit: z.number().int().min(1).max(100).optional(),
  queueEnabled: z.boolean().optional(),
  salesStart: z.string().datetime().nullable().optional(),
});
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const SalesReportQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
export const WebhookEventSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['payment.succeeded', 'payment.failed', 'refund.succeeded', 'refund.failed']),
  providerRef: z.string().min(1).max(100),
  merchantRef: z.string().min(1).max(100),
  amountKop: kop,
});
export const EventStatusSchema = z.enum(EVENT_STATUSES);
