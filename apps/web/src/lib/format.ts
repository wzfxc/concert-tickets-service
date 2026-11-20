'use client';

import { useLocale } from 'next-intl';
import { useMemo } from 'react';

const INTL_LOCALE: Record<string, string> = { uk: 'uk-UA', en: 'en-US', pl: 'pl-PL' };
const TIME_ZONE = 'Europe/Kyiv';

/** Money (integer kopecks → "1 234,50 ₴" in uk/pl, "₴1,234.50" in en) and event-time dates in Europe/Kyiv. */
export function useFormat() {
  const locale = useLocale();
  return useMemo(() => {
    const intl = INTL_LOCALE[locale] ?? 'uk-UA';
    const money = new Intl.NumberFormat(intl, {
      style: 'currency',
      currency: 'UAH',
      currencyDisplay: 'narrowSymbol',
    });
    const dateTime = new Intl.DateTimeFormat(intl, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: TIME_ZONE,
    });
    const time = new Intl.DateTimeFormat(intl, { timeStyle: 'medium', timeZone: TIME_ZONE });
    return {
      money: (kop: number): string => money.format(kop / 100),
      dateTime: (iso: string): string => dateTime.format(new Date(iso)),
      time: (iso: string): string => time.format(new Date(iso)),
    };
  }, [locale]);
}

export const kopFromUah = (uah: number): number => Math.round(uah * 100);

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
