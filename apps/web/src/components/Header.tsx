'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname, useRouter } from '../i18n/routing';
import { useAuth } from '../lib/auth';

const LOCALES = ['uk', 'en', 'pl'] as const;

export function Header() {
  const t = useTranslations('nav');
  const { user, logout } = useAuth();
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  const links: { href: string; label: string; show: boolean }[] = [
    { href: '/', label: t('events'), show: true },
    { href: '/tickets', label: t('tickets'), show: user?.role === 'buyer' },
    { href: '/organizer', label: t('organizer'), show: user?.role === 'organizer' },
    { href: '/controller', label: t('controller'), show: user?.role === 'controller' },
    { href: '/finance', label: t('finance'), show: user?.role === 'finance' },
  ];

  return (
    <header className="border-b bg-white">
      <nav
        className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3"
        aria-label="Main"
      >
        <Link href="/" className="text-lg font-semibold text-indigo-700">
          🎫 Tickets
        </Link>
        {links
          .filter((l) => l.show)
          .map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-gray-700 hover:text-indigo-700"
            >
              {l.label}
            </Link>
          ))}
        <a href="/docs" className="text-sm text-gray-500 hover:text-indigo-700">
          {t('docs')}
        </a>
        <a
          href={`http://${typeof window === 'undefined' ? 'localhost' : window.location.hostname}:8025`}
          className="text-sm text-gray-500 hover:text-indigo-700"
        >
          {t('mail')}
        </a>
        <div className="ml-auto flex items-center gap-3">
          <label className="text-sm text-gray-600">
            <span className="sr-only">{t('language')}</span>
            <select
              className="field w-auto"
              value={locale}
              onChange={(e) =>
                router.replace(pathname, { locale: e.target.value as (typeof LOCALES)[number] })
              }
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          {user ? (
            <>
              <span className="text-sm text-gray-600">{user.email}</span>
              <button className="btn-secondary" onClick={logout}>
                {t('logout')}
              </button>
            </>
          ) : (
            <Link href="/login" className="btn">
              {t('login')}
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
