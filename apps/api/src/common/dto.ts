import { z } from 'zod';
import {
  ErrorCodeSchema,
  EventStatusSchema,
  LocaleSchema,
  ORDER_STATUSES,
  USER_ROLES,
} from '@tickets/shared';

/** Response schemas. They drive the OpenAPI document, hence the generated web client (no hand-written types). */
const iso = z.string();
const kop = z.number().int();

export const UserDto = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(USER_ROLES),
  locale: LocaleSchema,
});
export const AuthDto = z.object({ token: z.string(), user: UserDto });

export const OkDto = z.object({ ok: z.literal(true) });

export const EventSummaryDto = z.object({
  id: z.string().uuid(),
  title: z.string(),
  category: z.string(),
  city: z.string(),
  startsAt: iso,
  status: EventStatusSchema,
  minPriceKop: kop.nullable(),
  hasSeats: z.boolean(),
});
export const EventSearchDto = z.object({
  items: z.array(EventSummaryDto),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});

export const ZoneDto = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(['seated', 'dancefloor']),
  capacity: z.number().int().nullable(),
  priceKop: kop.nullable(),
});
export const EventDetailDto = EventSummaryDto.extend({
  endsAt: iso.nullable(),
  salesStart: iso.nullable(),
  perUserLimit: z.number().int(),
  queueEnabled: z.boolean(),
  queueActive: z.boolean(),
  rescheduledAt: iso.nullable(),
  venueId: z.string().uuid(),
  organizerId: z.string().uuid(),
  zones: z.array(ZoneDto),
  serverNow: iso,
});

/** Seat map in columnar form (10 000 seats in one compact response). state: 0 free,1 held,2 sold,3 blocked,4 offered. */
export const MapDto = z.object({
  eventId: z.string().uuid(),
  seq: z.number().int(),
  serverNow: iso,
  zones: z.array(ZoneDto.extend({ taken: z.number().int(), offered: z.number().int() })),
  seats: z.object({
    ids: z.array(z.number().int()),
    zoneIdx: z.array(z.number().int()),
    rows: z.array(z.string()),
    numbers: z.array(z.number().int()),
    x: z.array(z.number()),
    y: z.array(z.number()),
    state: z.array(z.number().int()),
    priceKop: z.array(kop),
  }),
});

export const OrderItemDto = z.object({
  id: z.string().uuid(),
  zoneId: z.string().uuid(),
  seatId: z.number().int().nullable(),
  priceKop: kop,
  discountKop: kop,
  feeKop: kop,
  refunded: z.boolean(),
});
export const OrderDto = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  status: z.enum(ORDER_STATUSES),
  expiresAt: iso,
  serverNow: iso,
  promoCode: z.string().nullable(),
  subtotalKop: kop,
  discountKop: kop,
  feeKop: kop,
  totalKop: kop,
  paidKop: kop,
  refundedKop: kop,
  items: z.array(OrderItemDto),
});
export const OrderListDto = z.object({ items: z.array(OrderDto) });
export const OrderHistoryDto = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      fromStatus: z.string().nullable(),
      toStatus: z.string(),
      actor: z.string(),
      note: z.string().nullable(),
      at: iso,
    }),
  ),
});

export const PaymentStartDto = z.object({
  paymentId: z.string().uuid(),
  providerRef: z.string(),
  payUrl: z.string(),
  amountKop: kop,
});

export const RefundDto = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  amountKop: kop,
  feeKop: kop,
  kind: z.string(),
  status: z.enum(['pending', 'sent', 'done', 'failed']),
});

export const TicketDto = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  eventTitle: z.string(),
  startsAt: iso,
  zoneName: z.string(),
  row: z.string().nullable(),
  number: z.number().int().nullable(),
  status: z.string(),
  qrVersion: z.number().int(),
  qr: z.string(),
});
export const TicketListDto = z.object({ items: z.array(TicketDto) });

export const ScanOkDto = z.object({
  result: z.literal('ADMIT'),
  ticketId: z.string().uuid(),
  zoneName: z.string(),
  row: z.string().nullable(),
  number: z.number().int().nullable(),
  admitted: z.number().int(),
  remaining: z.number().int(),
});
export const ControllerEventListDto = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      startsAt: iso,
      status: z.string(),
    }),
  ),
});
export const GateStatsDto = z.object({
  eventId: z.string().uuid(),
  admitted: z.number().int(),
  remaining: z.number().int(),
  total: z.number().int(),
});

export const QueueStateDto = z.object({
  eventId: z.string().uuid(),
  status: z.enum(['waiting', 'admitted', 'done', 'expired', 'left']),
  position: z.number().int().nullable(),
  ahead: z.number().int().nullable(),
  estimatedWaitSeconds: z.number().int().nullable(),
  admitExpiresAt: iso.nullable(),
  maxSelectors: z.number().int(),
  serverNow: iso,
});

export const WaitlistDto = z.object({
  eventId: z.string().uuid(),
  status: z.enum(['waiting', 'offered', 'done', 'left']),
  quantity: z.number().int(),
  offerExpiresAt: iso.nullable(),
  offeredSeatIds: z.array(z.number().int()),
});

export const VenueDto = z.object({
  id: z.string().uuid(),
  name: z.string(),
  city: z.string(),
  seatCount: z.number().int(),
  zones: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      kind: z.enum(['seated', 'dancefloor']),
      capacity: z.number().int().nullable(),
    }),
  ),
});
export const VenueListDto = z.object({ items: z.array(VenueDto) });

export const OrganizerEventDto = EventSummaryDto.extend({
  venueId: z.string().uuid(),
  salesStart: iso.nullable(),
  perUserLimit: z.number().int(),
  queueEnabled: z.boolean(),
});
export const OrganizerEventListDto = z.object({ items: z.array(OrganizerEventDto) });

export const PromoDto = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid().nullable(),
  code: z.string(),
  kind: z.enum(['percent', 'fixed']),
  value: z.number().int(),
  usageLimit: z.number().int(),
  used: z.number().int(),
  validUntil: iso.nullable(),
});
export const PromoListDto = z.object({ items: z.array(PromoDto) });

export const CancelProgressDto = z.object({
  eventId: z.string().uuid(),
  status: z.enum(['none', 'running', 'done']),
  total: z.number().int(),
  done: z.number().int(),
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
});

export const SalesReportDto = z.object({
  eventId: z.string().uuid(),
  from: iso,
  to: iso,
  ticketsSold: z.number().int(),
  revenueKop: kop,
  capacity: z.number().int(),
  fillRate: z.number(),
  hourly: z.array(z.object({ hour: iso, tickets: z.number().int(), revenueKop: kop })),
  byZone: z.array(
    z.object({
      zoneId: z.string().uuid(),
      zoneName: z.string(),
      tickets: z.number().int(),
      revenueKop: kop,
    }),
  ),
  funnel: z.object({
    queueJoined: z.number().int(),
    queueAdmitted: z.number().int(),
    ordersCreated: z.number().int(),
    ordersPaid: z.number().int(),
    queueToPaid: z.number().int(),
  }),
});

export const FinanceReportDto = z.object({
  from: iso,
  to: iso,
  totals: z.object({
    salesKop: kop,
    serviceFeesKop: kop,
    commissionKop: kop,
    refundsKop: kop,
    payoutsKop: kop,
  }),
  byOrganizer: z.array(
    z.object({
      organizerId: z.string().uuid(),
      organizerName: z.string(),
      salesKop: kop,
      refundsKop: kop,
      commissionKop: kop,
      payoutsKop: kop,
    }),
  ),
});

export const ReconciliationDto = z.object({
  ledgerSumKop: kop,
  balanced: z.boolean(),
  accounts: z.array(
    z.object({
      code: z.string(),
      organizerId: z.string().uuid().nullable(),
      balanceKop: kop,
      entriesSumKop: kop,
      matches: z.boolean(),
    }),
  ),
  payouts: z.array(
    z.object({
      eventId: z.string().uuid(),
      expectedKop: kop,
      postedKop: kop,
      matches: z.boolean(),
    }),
  ),
  discrepancies: z.array(
    z.object({
      kind: z.enum(['payment', 'refund']),
      id: z.string(),
      providerRef: z.string(),
      ours: z.string(),
      provider: z.string(),
      resolved: z.boolean(),
    }),
  ),
});

export const JobsDto = z.object({
  failed: z.array(
    z.object({
      id: z.number().int(),
      queue: z.string(),
      jobKey: z.string(),
      error: z.string(),
      attempts: z.number().int(),
      failedAt: iso,
      retriedAt: iso.nullable(),
    }),
  ),
  stuck: z.array(
    z.object({
      queue: z.string(),
      key: z.string(),
      state: z.string(),
      ageSeconds: z.number().int(),
    }),
  ),
});

export const ErrorDto = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string(),
  }),
});
