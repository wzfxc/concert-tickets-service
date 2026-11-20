import {
  COMMISSION_PERCENT,
  RESCHEDULE_FULL_REFUND_MS,
  REFUND_FULL_BEFORE_MS,
  REFUND_HALF_BEFORE_MS,
  SERVICE_FEE_MIN_KOP,
  SERVICE_FEE_PERCENT,
  type EventStatus,
} from './constants.js';

function assertKop(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`${what} must be a non-negative integer of kopecks`);
  }
}

/** 5% of the (pre-promo) ticket price, rounded half-up, at least 20 ₴. Paid by the buyer. */
export function calcServiceFee(listPriceKop: number): number {
  assertKop(listPriceKop, 'price');
  return Math.max(Math.floor((listPriceKop * SERVICE_FEE_PERCENT + 50) / 100), SERVICE_FEE_MIN_KOP);
}

/** 8% of the price paid for tickets (after promo, without fee), rounded DOWN = in the organizer's favour. */
export function calcCommission(ticketsPaidKop: number): number {
  assertKop(ticketsPaidKop, 'amount');
  return Math.floor((ticketsPaidKop * COMMISSION_PERCENT) / 100);
}

/** Payout = sales − refunds − commission (commission is computed on net ticket revenue). */
export function calcPayout(
  salesKop: number,
  refundsKop: number,
): { commissionKop: number; payoutKop: number } {
  const net = salesKop - refundsKop;
  if (net < 0) throw new RangeError('refunds exceed sales');
  const commissionKop = calcCommission(net);
  return { commissionKop, payoutKop: net - commissionKop };
}

export interface PromoRule {
  kind: 'percent' | 'fixed';
  /** percent: 1..100; fixed: kopecks */
  value: number;
}

/**
 * Discount applies to ticket prices only, never to the service fee. Percent is rounded down (the buyer
 * pays the extra kopeck); the discount never exceeds the subtotal.
 */
export function calcPromoDiscount(subtotalKop: number, promo: PromoRule): number {
  assertKop(subtotalKop, 'subtotal');
  const raw =
    promo.kind === 'percent' ? Math.floor((subtotalKop * promo.value) / 100) : promo.value;
  return Math.min(Math.max(raw, 0), subtotalKop);
}

/** Splits a discount proportionally to ticket prices; the remainder goes to the first tickets; never below 0. */
export function distributeDiscount(pricesKop: readonly number[], discountKop: number): number[] {
  const total = pricesKop.reduce((a, b) => a + b, 0);
  if (total === 0 || discountKop <= 0) return pricesKop.map(() => 0);
  const parts = pricesKop.map((p) => Math.floor((p * discountKop) / total));
  let rest = discountKop - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < parts.length && rest > 0; i++) {
    const room = (pricesKop[i] ?? 0) - (parts[i] ?? 0);
    const add = Math.min(room, rest);
    parts[i] = (parts[i] ?? 0) + add;
    rest -= add;
  }
  return parts;
}

export interface TicketQuote {
  priceKop: number;
  discountKop: number;
  feeKop: number;
  /** what the buyer pays for this ticket: price − discount + fee */
  totalKop: number;
}

export function quoteTickets(
  pricesKop: readonly number[],
  promo?: PromoRule | null,
): TicketQuote[] {
  const discount = promo
    ? calcPromoDiscount(
        pricesKop.reduce((a, b) => a + b, 0),
        promo,
      )
    : 0;
  const parts = distributeDiscount(pricesKop, discount);
  return pricesKop.map((priceKop, i) => {
    const discountKop = parts[i] ?? 0;
    const feeKop = calcServiceFee(priceKop);
    return { priceKop, discountKop, feeKop, totalKop: priceKop - discountKop + feeKop };
  });
}

export interface RefundInput {
  /** price actually paid for the ticket (after promo, without fee) */
  ticketPaidKop: number;
  feeKop: number;
  eventStatus: EventStatus;
  startsAt: Date;
  rescheduledAt?: Date | null;
  now: Date;
}
export type RefundDecision =
  | {
      allowed: true;
      amountKop: number;
      includesFee: boolean;
      rule: 'cancelled' | 'rescheduled' | 'full' | 'half';
    }
  | { allowed: false; code: 'REFUND_WINDOW_CLOSED' };

/**
 * Spec rules: cancelled event = 100% incl. fee; rescheduled = full price within 14 days of the reschedule,
 * regardless of time left; otherwise more than 7 days before start = full price (no fee), 2–7 days
 * inclusive = 50%, less than 2 days = not allowed.
 */
export function calcRefund(i: RefundInput): RefundDecision {
  if (i.eventStatus === 'cancelled') {
    return {
      allowed: true,
      amountKop: i.ticketPaidKop + i.feeKop,
      includesFee: true,
      rule: 'cancelled',
    };
  }
  if (
    i.eventStatus === 'rescheduled' &&
    i.rescheduledAt &&
    i.now.getTime() - i.rescheduledAt.getTime() <= RESCHEDULE_FULL_REFUND_MS
  ) {
    return { allowed: true, amountKop: i.ticketPaidKop, includesFee: false, rule: 'rescheduled' };
  }
  const left = i.startsAt.getTime() - i.now.getTime();
  if (left > REFUND_FULL_BEFORE_MS) {
    return { allowed: true, amountKop: i.ticketPaidKop, includesFee: false, rule: 'full' };
  }
  if (left >= REFUND_HALF_BEFORE_MS) {
    return {
      allowed: true,
      amountKop: Math.floor(i.ticketPaidKop / 2),
      includesFee: false,
      rule: 'half',
    };
  }
  return { allowed: false, code: 'REFUND_WINDOW_CLOSED' };
}
