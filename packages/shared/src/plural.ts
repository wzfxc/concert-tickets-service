import type { Locale } from './constants.js';

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** CLDR plural category for a count: uk (1 / 2–4 / 5+), pl, en. */
export function pluralCategory(locale: Locale, n: number): PluralCategory {
  return new Intl.PluralRules(locale).select(n) as PluralCategory;
}

const TICKET_FORMS: Record<Locale, Partial<Record<PluralCategory, string>> & { other: string }> = {
  uk: { one: 'квиток', few: 'квитки', many: 'квитків', other: 'квитка' },
  pl: { one: 'bilet', few: 'bilety', many: 'biletów', other: 'biletu' },
  en: { one: 'ticket', other: 'tickets' },
};

/** "1 квиток", "3 квитки", "5 квитків", "3 bilety", "5 biletów", "1 ticket". */
export function formatTickets(locale: Locale, n: number): string {
  const forms = TICKET_FORMS[locale];
  return `${n} ${forms[pluralCategory(locale, n)] ?? forms.other}`;
}
