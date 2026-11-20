'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ErrorText } from '../../src/components/ErrorText';
import { Link, usePathname, useRouter } from '../../src/i18n/routing';
import { api, unwrap } from '../../src/lib/api';
import { kopFromUah, useFormat } from '../../src/lib/format';

const FIELDS = ['q', 'city', 'category', 'dateFrom', 'dateTo', 'priceMin', 'priceMax'] as const;

function Search() {
  const t = useTranslations('search');
  const tc = useTranslations('common');
  const ts = useTranslations('status.event');
  const fmt = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // Everything (filters, sort, page) lives in the URL, so reload and Back restore the exact state.
  const get = (k: string): string => params.get(k) ?? '';
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft(Object.fromEntries(FIELDS.map((k) => [k, get(k)])));
    // re-sync the form only when the URL changes
  }, [params]);

  const push = (next: Record<string, string>): void => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) sp.set(k, v);
    router.push(`${pathname}?${sp.toString()}` as never);
  };
  const current = (): Record<string, string> => Object.fromEntries([...params.entries()]);

  const page = Number(get('page') || 1);
  const query = {
    q: get('q') || undefined,
    city: get('city') || undefined,
    category: get('category') || undefined,
    dateFrom: get('dateFrom') || undefined,
    dateTo: get('dateTo') || undefined,
    priceMin: get('priceMin') ? kopFromUah(Number(get('priceMin'))) : undefined,
    priceMax: get('priceMax') ? kopFromUah(Number(get('priceMax'))) : undefined,
    hasSeats: get('hasSeats') === 'true' ? ('true' as const) : undefined,
    sort: (get('sort') || 'date') as 'date' | 'price' | 'title',
    order: (get('order') || 'asc') as 'asc' | 'desc',
    page,
    pageSize: 12,
  };
  const { data, error, isFetching } = useQuery({
    queryKey: ['events', query],
    queryFn: async () => unwrap(await api.GET('/api/events', { params: { query } })),
  });

  const submit = (e: React.SyntheticEvent): void => {
    e.preventDefault();
    push({ ...current(), ...draft, page: '' });
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <form
        onSubmit={submit}
        className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        aria-label={t('title')}
      >
        {FIELDS.map((k) => (
          <div key={k}>
            <label htmlFor={k} className="text-xs text-gray-600">
              {t(k)}
            </label>
            <input
              id={k}
              className="field"
              type={k.startsWith('date') ? 'date' : k.startsWith('price') ? 'number' : 'text'}
              value={draft[k] ?? ''}
              onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
            />
          </div>
        ))}
        <div className="flex items-end gap-2">
          <input
            id="hasSeats"
            type="checkbox"
            checked={get('hasSeats') === 'true'}
            onChange={(e) =>
              push({ ...current(), hasSeats: e.target.checked ? 'true' : '', page: '' })
            }
          />
          <label htmlFor="hasSeats">{t('hasSeats')}</label>
        </div>
        <div>
          <label htmlFor="sort" className="text-xs text-gray-600">
            {t('sort')}
          </label>
          <select
            id="sort"
            className="field"
            value={get('sort') || 'date'}
            onChange={(e) => push({ ...current(), sort: e.target.value, page: '' })}
          >
            <option value="date">{t('sortDate')}</option>
            <option value="price">{t('sortPrice')}</option>
            <option value="title">{t('sortTitle')}</option>
          </select>
        </div>
        <div>
          <label htmlFor="order" className="text-xs text-gray-600">
            &nbsp;
          </label>
          <select
            id="order"
            className="field"
            value={get('order') || 'asc'}
            onChange={(e) => push({ ...current(), order: e.target.value, page: '' })}
          >
            <option value="asc">{t('asc')}</option>
            <option value="desc">{t('desc')}</option>
          </select>
        </div>
        <div className="flex items-end">
          <button className="btn w-full" type="submit">
            {t('apply')}
          </button>
        </div>
      </form>

      <ErrorText error={error} />
      {data && <p className="text-sm text-gray-600">{t('found', { count: data.total })}</p>}
      {isFetching && !data && <p>{tc('loading')}</p>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.items.map((e) => (
          <li key={e.id} className="card">
            <Link
              href={`/events/${e.id}`}
              className="text-lg font-medium text-indigo-700 hover:underline"
            >
              {e.title}
            </Link>
            <p className="text-sm text-gray-600">
              {e.city} · {e.category}
            </p>
            <p className="text-sm">{fmt.dateTime(e.startsAt)}</p>
            <p className="mt-1 flex items-center justify-between text-sm">
              <span>
                {e.minPriceKop !== null ? t('from', { price: fmt.money(e.minPriceKop) }) : ''}
              </span>
              <span className={e.hasSeats ? 'text-green-700' : 'text-red-700'}>
                {e.hasSeats ? ts(e.status) : t('soldOut')}
              </span>
            </p>
          </li>
        ))}
      </ul>
      {data && data.total > data.pageSize && (
        <div className="flex items-center gap-3">
          <button
            className="btn-secondary"
            disabled={page <= 1}
            onClick={() => push({ ...current(), page: String(page - 1) })}
          >
            {tc('prev')}
          </button>
          <span className="text-sm">{tc('page', { page })}</span>
          <button
            className="btn-secondary"
            disabled={page * data.pageSize >= data.total}
            onClick={() => push({ ...current(), page: String(page + 1) })}
          >
            {tc('next')}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  return (
    <Suspense>
      <Search />
    </Suspense>
  );
}
