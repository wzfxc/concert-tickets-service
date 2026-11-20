'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { AssignControllerSchema, CreateEventSchema, CreatePromoSchema } from '@tickets/shared';
import { ErrorText, applyServerErrors } from '../../../src/components/ErrorText';
import { SeatMap, type MapSeats } from '../../../src/components/SeatMap';
import { useRequireRole } from '../../../src/lib/auth';
import { ApiError, api, unwrap } from '../../../src/lib/api';
import { kopFromUah, useFormat } from '../../../src/lib/format';
import { getSocket } from '../../../src/lib/socket';

const SAMPLE = JSON.stringify(
  {
    name: 'Sample Hall',
    city: 'Kyiv',
    zones: [
      {
        kind: 'seated',
        name: 'Stalls',
        rows: [
          { label: 'A', seats: 10 },
          { label: 'B', seats: 10 },
          { label: 'C', seats: 10 },
        ],
      },
      { kind: 'dancefloor', name: 'Dancefloor', capacity: 200 },
    ],
  },
  null,
  2,
);

const toIso = (local: string): string | undefined =>
  local ? new Date(local).toISOString() : undefined;

function Venues() {
  const t = useTranslations('org');
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const venues = useQuery({
    queryKey: ['venues'],
    queryFn: async () => unwrap(await api.GET('/api/venues')),
  });
  const upload = async (): Promise<void> => {
    setError(null);
    try {
      const body = JSON.parse(text) as never;
      unwrap(await api.POST('/api/venues', { body }));
      setText('');
      await qc.invalidateQueries({ queryKey: ['venues'] });
    } catch (err) {
      setError(
        err instanceof SyntaxError ? new ApiError('VALIDATION_ERROR', 'Invalid JSON', 400) : err,
      );
    }
  };
  return (
    <section className="card space-y-2">
      <h2 className="font-medium">{t('uploadTitle')}</h2>
      <label htmlFor="layout">{t('layoutJson')}</label>
      <textarea
        id="layout"
        className="field h-32 font-mono text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2">
        <button className="btn-secondary" onClick={() => setText(SAMPLE)}>
          {t('sample')}
        </button>
        <button className="btn" onClick={upload} disabled={!text}>
          {t('upload')}
        </button>
      </div>
      <ErrorText error={error} />
      <h3 className="pt-2 text-sm font-medium">{t('venues')}</h3>
      <ul className="text-sm">
        {venues.data?.items.map((v) => (
          <li key={v.id}>
            {v.name} · {v.city} · {t('seats', { count: v.seatCount })}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CreateEvent({ onCreated }: { onCreated: (id: string) => void }) {
  const t = useTranslations('org');
  const [error, setError] = useState<unknown>(null);
  const venues = useQuery({
    queryKey: ['venues'],
    queryFn: async () => unwrap(await api.GET('/api/venues')),
  });
  type V = {
    title: string;
    category: string;
    venueId: string;
    startsAt: string;
    salesStart: string;
    perUserLimit: number;
  };
  const form = useForm<V>({
    resolver: async (values, ctx, opts) => {
      const mapped = {
        ...values,
        startsAt: toIso(values.startsAt) ?? '',
        salesStart: toIso(values.salesStart),
        perUserLimit: Number(values.perUserLimit),
      };
      const res = await zodResolver(CreateEventSchema)(mapped as never, ctx, opts as never);
      return res as never;
    },
    defaultValues: {
      title: '',
      category: 'concert',
      venueId: '',
      startsAt: '',
      salesStart: '',
      perUserLimit: 6,
    },
  });
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const ev = unwrap(
        await api.POST('/api/events', {
          body: {
            title: v.title,
            category: v.category,
            venueId: v.venueId,
            startsAt: toIso(v.startsAt)!,
            salesStart: toIso(v.salesStart),
            perUserLimit: Number(v.perUserLimit),
          },
        }),
      );
      onCreated(ev.id);
    } catch (err) {
      setError(err);
      applyServerErrors(err, form.setError as never);
    }
  });
  const f = form.formState.errors;
  return (
    <form onSubmit={submit} className="card grid gap-2 sm:grid-cols-2" noValidate>
      <h2 className="font-medium sm:col-span-2">{t('createEvent')}</h2>
      <div>
        <label htmlFor="e-title">{t('eventTitle')}</label>
        <input id="e-title" className="field" {...form.register('title')} />
        {f.title && <p className="field-error">{f.title.message}</p>}
      </div>
      <div>
        <label htmlFor="e-cat">{t('category')}</label>
        <input id="e-cat" className="field" {...form.register('category')} />
      </div>
      <div>
        <label htmlFor="e-venue">{t('venue')}</label>
        <select id="e-venue" className="field" {...form.register('venueId')}>
          <option value="" />
          {venues.data?.items.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        {f.venueId && <p className="field-error">{f.venueId.message}</p>}
      </div>
      <div>
        <label htmlFor="e-limit">{t('limit')}</label>
        <input id="e-limit" type="number" className="field" {...form.register('perUserLimit')} />
      </div>
      <div>
        <label htmlFor="e-start">{t('startsAt')}</label>
        <input
          id="e-start"
          type="datetime-local"
          className="field"
          {...form.register('startsAt')}
        />
        {f.startsAt && <p className="field-error">{f.startsAt.message}</p>}
      </div>
      <div>
        <label htmlFor="e-sales">{t('salesStart')}</label>
        <input
          id="e-sales"
          type="datetime-local"
          className="field"
          {...form.register('salesStart')}
        />
      </div>
      <div className="sm:col-span-2">
        <ErrorText error={error} />
        <button className="btn mt-2" type="submit">
          {t('createEvent')}
        </button>
      </div>
    </form>
  );
}

function EventPanel({ id }: { id: string }) {
  const t = useTranslations('org');
  const tc = useTranslations('common');
  const fmt = useFormat();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [priceUah, setPriceUah] = useState('');
  const [zonePrice, setZonePrice] = useState<Record<string, string>>({});
  const [newStart, setNewStart] = useState('');

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: async () => unwrap(await api.GET('/api/events/{id}', { params: { path: { id } } })),
  });
  const map = useQuery({
    queryKey: ['org-map', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/events/{id}/map', { params: { path: { id } } })),
  });
  const promos = useQuery({
    queryKey: ['promos', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/events/{id}/promos', { params: { path: { id } } })),
  });
  const sales = useQuery({
    queryKey: ['sales', id],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/organizer/events/{id}/sales', { params: { path: { id }, query: {} } }),
      ),
  });
  const progress = useQuery({
    queryKey: ['cancel-progress', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/events/{id}/cancel-progress', { params: { path: { id } } })),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });

  // live cancellation progress (Socket.IO room cancel:{id}, organizer only)
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    socket.emit('cancel:subscribe', { eventId: id });
    const onProgress = (): void => void qc.invalidateQueries({ queryKey: ['cancel-progress', id] });
    socket.on('cancel:progress', onProgress);
    return () => {
      socket.off('cancel:progress', onProgress);
    };
  }, [id, qc]);

  const run = async (
    fn: () => Promise<void>,
    refresh: string[] = ['event', 'org-map', 'promos', 'sales', 'cancel-progress'],
  ): Promise<void> => {
    setError(null);
    try {
      await fn();
      for (const k of refresh) await qc.invalidateQueries({ queryKey: [k, id] });
    } catch (err) {
      setError(err);
    }
  };

  const promoForm = useForm<{
    code: string;
    kind: 'percent' | 'fixed';
    value: number;
    usageLimit: number;
  }>({
    resolver: async (v, c, o) => {
      const value = v.kind === 'fixed' ? kopFromUah(Number(v.value)) : Number(v.value);
      return zodResolver(CreatePromoSchema)(
        { ...v, eventId: id, value, usageLimit: Number(v.usageLimit) } as never,
        c,
        o as never,
      ) as never;
    },
    defaultValues: { code: '', kind: 'percent', value: 10, usageLimit: 100 },
  });
  const addPromo = promoForm.handleSubmit((v) =>
    run(async () => {
      const value = v.kind === 'fixed' ? kopFromUah(Number(v.value)) : Number(v.value);
      unwrap(
        await api.POST('/api/promos', {
          body: {
            eventId: id,
            code: v.code,
            kind: v.kind,
            value,
            usageLimit: Number(v.usageLimit),
          },
        }),
      );
      promoForm.reset();
    }),
  );
  const ctrlForm = useForm<{ email: string }>({
    resolver: zodResolver(AssignControllerSchema),
    defaultValues: { email: '' },
  });
  const assign = ctrlForm.handleSubmit(async (v) => {
    await run(async () => {
      unwrap(await api.POST('/api/events/{id}/controllers', { params: { path: { id } }, body: v }));
      ctrlForm.reset();
    });
  });

  const ev = event.data;
  const seats: MapSeats | undefined = map.data?.seats;
  const toggle = (sid: number): void =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  if (!ev) return <p>{tc('loading')}</p>;
  const draft = ev.status === 'draft';

  return (
    <div className="space-y-4" data-testid="event-panel">
      <h2 className="text-xl font-semibold">
        {ev.title} · {ev.status}
      </h2>
      <ErrorText error={error} />

      <section className="card space-y-2">
        <h3 className="font-medium">{t('prices')}</h3>
        {ev.zones.map((z) => (
          <div key={z.id} className="flex items-center gap-2 text-sm">
            <span className="w-40">
              {z.name} ({z.priceKop !== null ? fmt.money(z.priceKop) : '—'})
            </span>
            <input
              aria-label={t('price')}
              type="number"
              min={1}
              className="field w-28"
              value={zonePrice[z.id] ?? ''}
              onChange={(e) => setZonePrice({ ...zonePrice, [z.id]: e.target.value })}
            />
            <button
              className="btn-secondary"
              disabled={!zonePrice[z.id]}
              onClick={() =>
                run(async () => {
                  unwrap(
                    await api.PUT('/api/events/{id}/prices', {
                      params: { path: { id } },
                      body: {
                        zonePrices: [
                          { zoneId: z.id, priceKop: kopFromUah(Number(zonePrice[z.id])) },
                        ],
                        seatPrices: [],
                        blockedSeatIds: [],
                      },
                    }),
                  );
                })
              }
            >
              {t('setZonePrice')}
            </button>
          </div>
        ))}
        {seats && seats.ids.length > 0 && (
          <>
            <SeatMap seats={seats} selected={selected} onToggle={toggle} />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <input
                aria-label={t('price')}
                type="number"
                min={1}
                className="field w-28"
                value={priceUah}
                onChange={(e) => setPriceUah(e.target.value)}
              />
              <button
                className="btn-secondary"
                disabled={!priceUah || selected.size === 0}
                onClick={() =>
                  run(async () => {
                    unwrap(
                      await api.PUT('/api/events/{id}/prices', {
                        params: { path: { id } },
                        body: {
                          zonePrices: [],
                          seatPrices: [
                            { seatIds: [...selected], priceKop: kopFromUah(Number(priceUah)) },
                          ],
                          blockedSeatIds: [],
                        },
                      }),
                    );
                    setSelected(new Set());
                  })
                }
              >
                {t('setSeatPrice')}
              </button>
              <button
                className="btn-secondary"
                disabled={selected.size === 0}
                onClick={() =>
                  run(async () => {
                    unwrap(
                      await api.PUT('/api/events/{id}/prices', {
                        params: { path: { id } },
                        body: { zonePrices: [], seatPrices: [], blockedSeatIds: [...selected] },
                      }),
                    );
                    setSelected(new Set());
                  })
                }
              >
                {t('blockSeats')}
              </button>
            </div>
          </>
        )}
        {draft && (
          <button
            className="btn"
            onClick={() =>
              run(
                async () =>
                  void unwrap(
                    await api.POST('/api/events/{id}/publish', { params: { path: { id } } }),
                  ),
              )
            }
          >
            {t('publish')}
          </button>
        )}
      </section>

      <section className="card space-y-2">
        <h3 className="font-medium">{t('settings')}</h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={ev.queueEnabled}
            onChange={(e) =>
              run(
                async () =>
                  void unwrap(
                    await api.PATCH('/api/events/{id}/settings', {
                      params: { path: { id } },
                      body: { queueEnabled: e.target.checked },
                    }),
                  ),
              )
            }
          />
          {t('queueEnabled')}
        </label>
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="resched">{t('reschedule')}</label>
          <input
            id="resched"
            type="datetime-local"
            className="field w-56"
            value={newStart}
            onChange={(e) => setNewStart(e.target.value)}
          />
          <button
            className="btn-secondary"
            disabled={!newStart}
            onClick={() =>
              run(
                async () =>
                  void unwrap(
                    await api.POST('/api/events/{id}/reschedule', {
                      params: { path: { id } },
                      body: { startsAt: toIso(newStart)! },
                    }),
                  ),
              )
            }
          >
            {t('reschedule')}
          </button>
        </div>
      </section>

      <section className="card space-y-2">
        <h3 className="font-medium">{t('promos')}</h3>
        <ul className="text-sm">
          {promos.data?.items.map((p) => (
            <li key={p.id}>
              {p.code} — {p.kind === 'percent' ? `${p.value}%` : fmt.money(p.value)} —{' '}
              {t('used', { used: p.used, limit: p.usageLimit })}
            </li>
          ))}
        </ul>
        <form onSubmit={addPromo} className="grid gap-2 sm:grid-cols-4" noValidate>
          <div>
            <label htmlFor="p-code">{t('promoCode')}</label>
            <input id="p-code" className="field" {...promoForm.register('code')} />
            {promoForm.formState.errors.code && (
              <p className="field-error">{promoForm.formState.errors.code.message}</p>
            )}
          </div>
          <div>
            <label htmlFor="p-kind">{t('promoKind')}</label>
            <select id="p-kind" className="field" {...promoForm.register('kind')}>
              <option value="percent">{t('percent')}</option>
              <option value="fixed">{t('fixed')}</option>
            </select>
          </div>
          <div>
            <label htmlFor="p-val">{t('promoValue')}</label>
            <input id="p-val" type="number" className="field" {...promoForm.register('value')} />
            {promoForm.formState.errors.value && (
              <p className="field-error">{promoForm.formState.errors.value.message}</p>
            )}
          </div>
          <div>
            <label htmlFor="p-lim">{t('promoLimit')}</label>
            <input
              id="p-lim"
              type="number"
              className="field"
              {...promoForm.register('usageLimit')}
            />
          </div>
          <button className="btn sm:col-span-4" type="submit">
            {tc('create')}
          </button>
        </form>
      </section>

      <section className="card">
        <h3 className="font-medium">{t('controllers')}</h3>
        <form onSubmit={assign} className="flex items-end gap-2" noValidate>
          <div className="flex-1">
            <label htmlFor="c-email">{t('controllerEmail')}</label>
            <input id="c-email" type="email" className="field" {...ctrlForm.register('email')} />
            {ctrlForm.formState.errors.email && (
              <p className="field-error">{ctrlForm.formState.errors.email.message}</p>
            )}
          </div>
          <button className="btn" type="submit">
            {t('assign')}
          </button>
        </form>
      </section>

      <section className="card space-y-1 text-sm">
        <h3 className="font-medium">{t('sales')}</h3>
        {sales.data && (
          <>
            <p>
              {t('ticketsSold')}: {sales.data.ticketsSold} · {t('revenue')}:{' '}
              {fmt.money(sales.data.revenueKop)} · {t('fill')}:{' '}
              {Math.round(sales.data.fillRate * 100)}%
            </p>
            <p className="font-medium">{t('byZone')}</p>
            <ul>
              {sales.data.byZone.map((z) => (
                <li key={z.zoneId}>
                  {z.zoneName}: {z.tickets} · {fmt.money(z.revenueKop)}
                </li>
              ))}
            </ul>
            <p className="font-medium">{t('funnel')}</p>
            <p>
              {t('queueJoined')}: {sales.data.funnel.queueJoined} · {t('queueAdmitted')}:{' '}
              {sales.data.funnel.queueAdmitted} · {t('ordersCreated')}:{' '}
              {sales.data.funnel.ordersCreated} · {t('ordersPaid')}: {sales.data.funnel.ordersPaid}{' '}
              · {t('queueToPaid')}: {Math.round(sales.data.funnel.queueToPaid * 100)}%
            </p>
            <p className="font-medium">{t('hourly')}</p>
            <ul className="max-h-32 overflow-auto">
              {sales.data.hourly.map((h) => (
                <li key={h.hour}>
                  {fmt.dateTime(h.hour)}: {h.tickets} · {fmt.money(h.revenueKop)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card space-y-2">
        {progress.data && progress.data.status !== 'none' && (
          <p role="status" data-testid="cancel-progress">
            {t('progress', { done: progress.data.done, total: progress.data.total })}
          </p>
        )}
        {ev.status !== 'cancelled' && (
          <button
            className="btn-danger"
            onClick={() => {
              if (window.confirm(t('cancelConfirm')))
                void run(
                  async () =>
                    void unwrap(
                      await api.POST('/api/events/{id}/cancel', { params: { path: { id } } }),
                    ),
                );
            }}
          >
            {t('cancelEvent')}
          </button>
        )}
      </section>
    </div>
  );
}

export default function OrganizerPage() {
  const t = useTranslations('org');
  const fmt = useFormat();
  const ready = useRequireRole('organizer');
  const qc = useQueryClient();
  const [current, setCurrent] = useState<string | null>(null);
  const events = useQuery({
    queryKey: ['org-events'],
    enabled: ready,
    queryFn: async () => unwrap(await api.GET('/api/organizer/events')),
  });
  if (!ready) return null;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <Venues />
      <CreateEvent
        onCreated={(id) => {
          setCurrent(id);
          void qc.invalidateQueries({ queryKey: ['org-events'] });
        }}
      />
      <section className="card">
        <h2 className="mb-2 font-medium">{t('events')}</h2>
        <ul className="space-y-1 text-sm">
          {events.data?.items.map((e) => (
            <li key={e.id}>
              <button
                className={`underline ${current === e.id ? 'font-semibold' : ''}`}
                onClick={() => setCurrent(e.id)}
              >
                {e.title}
              </button>{' '}
              · {e.status} · {fmt.dateTime(e.startsAt)}
            </li>
          ))}
        </ul>
      </section>
      {current ? (
        <EventPanel key={current} id={current} />
      ) : (
        <p className="text-sm text-gray-600">{t('select')}</p>
      )}
    </div>
  );
}
