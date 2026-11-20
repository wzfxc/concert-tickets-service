import { describe, expect, it } from 'vitest';
import {
  CreateHoldSchema,
  CreatePromoSchema,
  MS,
  OffsetClock,
  VenueLayoutSchema,
  calcCommission,
  calcPayout,
  calcPromoDiscount,
  calcRefund,
  calcServiceFee,
  distributeDiscount,
  formatTickets,
  pluralCategory,
  quoteTickets,
} from './index.js';
import { signQr, verifyQr } from './qr.js';

describe('service fee: 5%, min 20 ₴, half-up', () => {
  it.each([
    [100_000, 5000], // 1000 ₴ -> 50 ₴
    [40_000, 2000], // exactly the minimum
    [10_000, 2000], // 5% = 5 ₴ -> min 20 ₴
    [0, 2000],
    [100_010, 5001], // 5000.5 -> half-up
    [100_009, 5000], // 5000.45 -> 5000
  ])('price %i kop -> fee %i', (price, fee) => expect(calcServiceFee(price)).toBe(fee));

  it('rejects floats and negatives', () => {
    expect(() => calcServiceFee(10.5)).toThrow(RangeError);
    expect(() => calcServiceFee(-1)).toThrow(RangeError);
  });
});

describe('commission: 8%, rounded in the organizer favour (down)', () => {
  it.each([
    [100_000, 8000],
    [101, 8], // 8.08
    [112, 8], // 8.96 -> 8, not 9
    [12, 0],
  ])('%i -> %i', (amount, c) => expect(calcCommission(amount)).toBe(c));

  it('payout = sales − refunds − commission, no kopeck lost', () => {
    const r = calcPayout(1_000_000, 150_000);
    expect(r).toEqual({ commissionKop: 68_000, payoutKop: 782_000 });
    expect(r.payoutKop + r.commissionKop + 150_000).toBe(1_000_000);
    expect(() => calcPayout(100, 200)).toThrow(RangeError);
  });
});

describe('promo', () => {
  it('percent rounds down, fixed capped at subtotal, never touches the fee', () => {
    expect(calcPromoDiscount(10_001, { kind: 'percent', value: 10 })).toBe(1000);
    expect(calcPromoDiscount(5000, { kind: 'fixed', value: 9000 })).toBe(5000);
    const [q] = quoteTickets([100_000], { kind: 'percent', value: 100 });
    expect(q).toEqual({ priceKop: 100_000, discountKop: 100_000, feeKop: 5000, totalKop: 5000 });
  });

  it('distributes the discount proportionally, remainder to the first ticket, sums exactly', () => {
    const parts = distributeDiscount([10_000, 10_000, 10_000], 100);
    expect(parts).toEqual([34, 33, 33]);
    expect(distributeDiscount([5000, 100], 5100)).toEqual([5000, 100]);
    const mixed = distributeDiscount([333, 777, 1234], 999);
    expect(mixed.reduce((a, b) => a + b, 0)).toBe(999);
    mixed.forEach((m, i) => expect(m).toBeLessThanOrEqual([333, 777, 1234][i]!));
  });
});

describe('refund rules', () => {
  const startsAt = new Date('2030-06-30T18:00:00Z');
  const at = (msBefore: number) => new Date(startsAt.getTime() - msBefore);
  const base = { ticketPaidKop: 100_001, feeKop: 5000, eventStatus: 'on_sale' as const, startsAt };

  it('more than 7 days: full price, no fee', () => {
    expect(calcRefund({ ...base, now: at(7 * MS.day + 1) })).toMatchObject({
      allowed: true,
      amountKop: 100_001,
      includesFee: false,
    });
  });
  it('exactly 7 days and exactly 2 days: 50%', () => {
    expect(calcRefund({ ...base, now: at(7 * MS.day) })).toMatchObject({
      amountKop: 50_000,
      rule: 'half',
    });
    expect(calcRefund({ ...base, now: at(2 * MS.day) })).toMatchObject({
      amountKop: 50_000,
      rule: 'half',
    });
  });
  it('less than 2 days: refused', () => {
    expect(calcRefund({ ...base, now: at(2 * MS.day - 1) })).toEqual({
      allowed: false,
      code: 'REFUND_WINDOW_CLOSED',
    });
  });
  it('cancelled event: 100% including the fee, whatever the time left', () => {
    expect(calcRefund({ ...base, eventStatus: 'cancelled', now: at(MS.hour) })).toMatchObject({
      amountKop: 105_001,
      includesFee: true,
    });
  });
  it('rescheduled: full price for 14 days regardless of time left, then ordinary rules', () => {
    const rescheduledAt = new Date('2030-06-29T12:00:00Z');
    const common = { ...base, eventStatus: 'rescheduled' as const, rescheduledAt };
    const inside = new Date(rescheduledAt.getTime() + 14 * MS.day);
    expect(
      calcRefund({ ...common, startsAt: new Date(inside.getTime() + MS.hour), now: inside }),
    ).toMatchObject({
      amountKop: 100_001,
      rule: 'rescheduled',
    });
    const after = new Date(rescheduledAt.getTime() + 14 * MS.day + 1);
    expect(
      calcRefund({ ...common, startsAt: new Date(after.getTime() + MS.hour), now: after }),
    ).toEqual({
      allowed: false,
      code: 'REFUND_WINDOW_CLOSED',
    });
  });
});

describe('QR', () => {
  const secret = 'test-secret';
  const id = '3f2b8a52-8f0e-4b0c-9a55-0c1f4f3f9d11';

  it('round-trips and carries the version', () => {
    expect(verifyQr(secret, signQr(secret, id, 3))).toEqual({ ok: true, ticketId: id, version: 3 });
  });
  it('rejects tampered version, id, signature, other secret and garbage', () => {
    const good = signQr(secret, id, 1);
    expect(verifyQr(secret, good.replace('.1.', '.2.'))).toEqual({
      ok: false,
      code: 'INVALID_SIGNATURE',
    });
    expect(verifyQr(secret, good.replace('3f2b', '3f2c'))).toEqual({
      ok: false,
      code: 'INVALID_SIGNATURE',
    });
    expect(verifyQr(secret, good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A'))).toMatchObject({
      ok: false,
    });
    expect(verifyQr('other', good)).toMatchObject({ ok: false });
    expect(verifyQr(secret, 'nonsense')).toMatchObject({ ok: false });
  });
});

describe('plurals', () => {
  it('uk: 1 / 2–4 / 5+', () => {
    expect([1, 2, 4, 5, 11, 21, 22].map((n) => formatTickets('uk', n))).toEqual([
      '1 квиток',
      '2 квитки',
      '4 квитки',
      '5 квитків',
      '11 квитків',
      '21 квиток',
      '22 квитки',
    ]);
  });
  it('pl and en', () => {
    expect([1, 3, 5, 12, 22].map((n) => formatTickets('pl', n))).toEqual([
      '1 bilet',
      '3 bilety',
      '5 biletów',
      '12 biletów',
      '22 bilety',
    ]);
    expect([1, 3].map((n) => formatTickets('en', n))).toEqual(['1 ticket', '3 tickets']);
    expect(pluralCategory('uk', 3)).toBe('few');
  });
});

describe('schemas', () => {
  const eventId = '3f2b8a52-8f0e-4b0c-9a55-0c1f4f3f9d11';
  it('hold: at most 6 tickets, no duplicates, at least one', () => {
    expect(CreateHoldSchema.safeParse({ eventId, seatIds: [1, 2, 3, 4, 5, 6] }).success).toBe(true);
    expect(CreateHoldSchema.safeParse({ eventId, seatIds: [1, 2, 3, 4, 5, 6, 7] }).success).toBe(
      false,
    );
    expect(CreateHoldSchema.safeParse({ eventId, seatIds: [1, 1] }).success).toBe(false);
    expect(CreateHoldSchema.safeParse({ eventId }).success).toBe(false);
    expect(
      CreateHoldSchema.safeParse({
        eventId,
        seatIds: [1, 2],
        zones: [{ zoneId: eventId, quantity: 5 }],
      }).success,
    ).toBe(false);
  });
  it('promo percent ≤ 100; venue layout needs zones', () => {
    const p = { code: 'SALE', kind: 'percent', value: 101, usageLimit: 10 };
    expect(CreatePromoSchema.safeParse(p).success).toBe(false);
    expect(CreatePromoSchema.safeParse({ ...p, value: 100 }).success).toBe(true);
    expect(VenueLayoutSchema.safeParse({ name: 'V', city: 'Kyiv', zones: [] }).success).toBe(false);
    expect(
      VenueLayoutSchema.safeParse({
        name: 'V',
        city: 'Kyiv',
        zones: [
          { kind: 'seated', name: 'A', rows: [{ label: '1', seats: 10 }] },
          { kind: 'dancefloor', name: 'DF', capacity: 500 },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('OffsetClock', () => {
  it('shifts time', () => {
    const c = new OffsetClock();
    const t0 = c.now().getTime();
    c.advance(11 * MS.minute);
    expect(c.now().getTime() - t0).toBeGreaterThanOrEqual(11 * MS.minute);
  });
});
