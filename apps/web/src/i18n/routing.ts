import { defineRouting } from 'next-intl/routing';
import { createNavigation } from 'next-intl/navigation';

/** Locales required by the spec; `uk` is the default. */
export const routing = defineRouting({
  locales: ['uk', 'en', 'pl'],
  defaultLocale: 'uk',
  localePrefix: 'always',
});

export const { Link, redirect, usePathname, useRouter } = createNavigation(routing);
export type AppLocale = (typeof routing.locales)[number];
