'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ErrorText } from '../../../src/components/ErrorText';
import { usePathname, useRouter } from '../../../src/i18n/routing';
import { api, newKey, unwrap } from '../../../src/lib/api';
import { useRequireRole } from '../../../src/lib/auth';
import { kopFromUah, useFormat } from '../../../src/lib/format';

const today = (): string => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number): string =>
  new Date(new Date().getTime() - n * 86_400_000).toISOString().slice(0, 10);

function Finance() {
  const t = useTranslations('fin');
  const fmt = useFormat();
  const qc = useQueryClient();
  const ready = useRequireRole('finance');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [refundForm, setRefundForm] = useState({ orderId: '', amount: '', reason: '' });

  // The report period lives in the URL (reload / Back restore it).
  const from = params.get('from') ?? daysAgo(30);
  const to = params.get('to') ?? today();
  const [draft, setDraft] = useState({ from, to });
  // Back / Forward change the URL: the form must follow it.
  useEffect(() => setDraft({ from, to }), [from, to]);
  const setPeriod = (e: React.SyntheticEvent): void => {
    e.preventDefault();
    router.push(`${pathname}?from=${draft.from}&to=${draft.to}` as never);
  };

  const report = useQuery({
    queryKey: ['fin-report', from, to],
    enabled: ready,
    queryFn: async () =>
      unwrap(await api.GET('/api/finance/report', { params: { query: { from, to } } })),
  });
  const recon = useQuery({
    queryKey: ['recon'],
    enabled: ready,
    queryFn: async () => unwrap(await api.GET('/api/finance/reconciliation')),
  });
  const jobs = useQuery({
    queryKey: ['jobs'],
    enabled: ready,
    refetchInterval: 10_000,
    queryFn: async () => unwrap(await api.GET('/api/finance/jobs')),
  });

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    setNotice('');
    try {
      await fn();
    } catch (err) {
      setError(err);
    }
  };

  if (!ready) return null;
  const r = report.data;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ErrorText error={error} />
      {notice && <p role="status">{notice}</p>}

      <section className="card space-y-2">
        <h2 className="font-medium">{t('report')}</h2>
        <form onSubmit={setPeriod} className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="f-from">{t('from')}</label>
            <input
              id="f-from"
              type="date"
              className="field"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="f-to">{t('to')}</label>
            <input
              id="f-to"
              type="date"
              className="field"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </div>
          <button className="btn" type="submit">
            {t('show')}
          </button>
        </form>
        {r && (
          <>
            <p className="text-sm" data-testid="fin-totals">
              {t('sales')}: {fmt.money(r.totals.salesKop)} · {t('fees')}:{' '}
              {fmt.money(r.totals.serviceFeesKop)} · {t('commission')}:{' '}
              {fmt.money(r.totals.commissionKop)} · {t('refunds')}: {fmt.money(r.totals.refundsKop)}{' '}
              · {t('payouts')}: {fmt.money(r.totals.payoutsKop)}
            </p>
            <h3 className="text-sm font-medium">{t('byOrganizer')}</h3>
            <ul className="text-sm">
              {r.byOrganizer.map((o) => (
                <li key={o.organizerId}>
                  {o.organizerName}: {fmt.money(o.salesKop)} / {fmt.money(o.refundsKop)} /{' '}
                  {fmt.money(o.commissionKop)} / {fmt.money(o.payoutsKop)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="font-medium">{t('reconciliation')}</h2>
        {recon.data && (
          <>
            <p
              className={recon.data.balanced ? 'text-green-700' : 'text-red-700'}
              data-testid="ledger-balance"
            >
              {t('ledgerSum')}: {fmt.money(recon.data.ledgerSumKop)} —{' '}
              {recon.data.balanced ? t('balanced') : t('unbalanced')}
            </p>
            <h3 className="text-sm font-medium">{t('accounts')}</h3>
            <ul className="text-sm">
              {recon.data.accounts.map((a) => (
                <li
                  key={`${a.code}-${a.organizerId ?? ''}`}
                  className={a.matches ? '' : 'text-red-700'}
                >
                  {a.code}: {fmt.money(a.balanceKop)}
                </li>
              ))}
            </ul>
            <h3 className="text-sm font-medium">{t('discrepancies')}</h3>
            {recon.data.discrepancies.length === 0 ? (
              <p className="text-sm">{t('noDiscrepancies')}</p>
            ) : (
              <ul className="text-sm">
                {recon.data.discrepancies.map((d) => (
                  <li key={`${d.kind}-${d.id}`}>
                    {d.kind} {d.providerRef}: {d.ours} ≠ {d.provider}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <button
          className="btn"
          onClick={() =>
            run(async () => {
              unwrap(await api.POST('/api/finance/reconciliation/run'));
              await qc.invalidateQueries({ queryKey: ['recon'] });
            })
          }
        >
          {t('run')}
        </button>
      </section>

      <section className="card space-y-2">
        <h2 className="font-medium">{t('manualRefund')}</h2>
        <form
          className="grid gap-2 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              unwrap(
                await api.POST('/api/finance/refunds', {
                  params: { header: { 'Idempotency-Key': newKey() } },
                  body: {
                    orderId: refundForm.orderId,
                    amountKop: kopFromUah(Number(refundForm.amount)),
                    reason: refundForm.reason,
                  },
                }),
              );
              setNotice(t('refund'));
              setRefundForm({ orderId: '', amount: '', reason: '' });
            });
          }}
        >
          <div>
            <label htmlFor="r-order">{t('orderId')}</label>
            <input
              id="r-order"
              className="field"
              value={refundForm.orderId}
              onChange={(e) => setRefundForm({ ...refundForm, orderId: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="r-amount">{t('amount')}</label>
            <input
              id="r-amount"
              type="number"
              step="0.01"
              className="field"
              value={refundForm.amount}
              onChange={(e) => setRefundForm({ ...refundForm, amount: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="r-reason">{t('reason')}</label>
            <input
              id="r-reason"
              className="field"
              value={refundForm.reason}
              onChange={(e) => setRefundForm({ ...refundForm, reason: e.target.value })}
            />
          </div>
          <button className="btn sm:col-span-3" type="submit">
            {t('refund')}
          </button>
        </form>
      </section>

      <section className="card space-y-2">
        <h2 className="font-medium">{t('jobs')}</h2>
        <h3 className="text-sm font-medium">{t('failed')}</h3>
        <ul className="space-y-1 text-sm">
          {jobs.data?.failed.map((j) => (
            <li key={j.id} className="flex items-center gap-2">
              <span className="flex-1">
                {j.queue} · {j.jobKey} · {j.error} ({j.attempts})
              </span>
              {!j.retriedAt && (
                <button
                  className="btn-secondary"
                  onClick={() =>
                    run(async () => {
                      unwrap(
                        await api.POST('/api/finance/jobs/{id}/retry', {
                          params: { path: { id: String(j.id) } },
                        }),
                      );
                      await qc.invalidateQueries({ queryKey: ['jobs'] });
                    })
                  }
                >
                  {t('retry')}
                </button>
              )}
            </li>
          ))}
        </ul>
        <h3 className="text-sm font-medium">{t('stuck')}</h3>
        <ul className="text-sm">
          {jobs.data?.stuck.map((s) => (
            <li key={`${s.queue}-${s.key}`}>
              {s.queue} · {s.key} · {s.state} · {s.ageSeconds}s
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function FinancePage() {
  return (
    <Suspense>
      <Finance />
    </Suspense>
  );
}
