'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { use, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApplyPromoSchema } from '@tickets/shared';
import { ErrorText, applyServerErrors } from '../../../../src/components/ErrorText';
import { Link, useRouter } from '../../../../src/i18n/routing';
import { api, newKey, unwrap } from '../../../../src/lib/api';
import { useServerCountdown } from '../../../../src/lib/clock';
import { formatCountdown, useFormat } from '../../../../src/lib/format';
import { getSocket } from '../../../../src/lib/socket';

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('order');
  const tss = useTranslations('status.order');
  const fmt = useFormat();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);

  const order = useQuery({
    queryKey: ['order', id],
    queryFn: async () => unwrap(await api.GET('/api/orders/{id}', { params: { path: { id } } })),
    // while a payment may be settling, poll; the webhook may arrive late or twice
    refetchInterval: (q) => (q.state.data?.status === 'awaiting_payment' ? 2000 : false),
  });
  const history = useQuery({
    queryKey: ['order-history', id, order.data?.status],
    queryFn: async () =>
      unwrap(await api.GET('/api/orders/{id}/history', { params: { path: { id } } })),
  });

  const o = order.data;
  const left = useServerCountdown(o?.expiresAt, o?.serverNow);
  const active = o?.status === 'holding' || o?.status === 'awaiting_payment';
  const expired = active && left !== null && left <= 0;

  // realtime order updates (payment result) complement polling
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const refresh = (): void => void qc.invalidateQueries({ queryKey: ['order', id] });
    socket.on('order:update', refresh);
    return () => {
      socket.off('order:update', refresh);
    };
  }, [id, qc]);
  useEffect(() => {
    if (expired) void qc.invalidateQueries({ queryKey: ['order', id] });
  }, [expired, qc, id]);

  const promo = useForm<{ code: string }>({
    resolver: zodResolver(ApplyPromoSchema),
    defaultValues: { code: '' },
  });

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['order', id] });
    } catch (err) {
      setError(err);
    }
  };

  const applyPromo = promo.handleSubmit(async (v) => {
    setError(null);
    try {
      unwrap(await api.POST('/api/orders/{id}/promo', { params: { path: { id } }, body: v }));
      promo.reset();
      await qc.invalidateQueries({ queryKey: ['order', id] });
    } catch (err) {
      setError(err);
      applyServerErrors(err, promo.setError as never);
    }
  });

  const pay = (): Promise<void> =>
    run(async () => {
      const res = unwrap(
        await api.POST('/api/payments', {
          params: { header: { 'Idempotency-Key': newKey() } },
          body: { orderId: id },
        }),
      );
      window.location.assign(res.payUrl);
    });

  if (order.error) return <ErrorText error={order.error} />;
  if (!o) return <p>…</p>;
  const canEdit = o.status === 'holding' && !expired;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-sm" data-testid="order-status">
        {tss(o.status)}
      </p>
      {active && (
        <p
          className={`text-lg font-medium ${expired ? 'text-red-700' : ''}`}
          role="timer"
          data-testid="order-timer"
        >
          {expired ? t('timerExpired') : t('timer', { time: formatCountdown(left ?? 0) })}
        </p>
      )}
      {o.status === 'paid' && (
        <div className="card text-green-800" role="status">
          <p>{t('paidMessage')}</p>
          <Link href="/tickets" className="font-medium underline">
            {t('goTickets')}
          </Link>
        </div>
      )}
      {o.status === 'awaiting_payment' && (
        <p className="text-sm text-gray-600">{t('paymentPending')}</p>
      )}

      <table className="card w-full text-sm">
        <tbody>
          {o.items.map((it) => (
            <tr key={it.id}>
              <td className="py-1">{it.seatId !== null ? `#${it.seatId}` : '—'}</td>
              <td className="py-1 text-right">{fmt.money(it.priceKop)}</td>
              <td className="py-1 text-right">
                {canEdit && it.seatId !== null && o.items.length > 1 && (
                  <button
                    className="text-red-700 underline"
                    onClick={() =>
                      run(async () => {
                        unwrap(
                          await api.PATCH('/api/orders/{id}/seats', {
                            params: { path: { id } },
                            body: { addSeatIds: [], removeSeatIds: [it.seatId!] },
                          }),
                        );
                      })
                    }
                  >
                    {t('remove')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>{t('subtotal')}</td>
            <td className="text-right">{fmt.money(o.subtotalKop)}</td>
          </tr>
          {o.discountKop > 0 && (
            <tr>
              <td colSpan={2}>
                {t('discount')} {o.promoCode ? `(${o.promoCode})` : ''}
              </td>
              <td className="text-right">−{fmt.money(o.discountKop)}</td>
            </tr>
          )}
          <tr>
            <td colSpan={2}>{t('fee')}</td>
            <td className="text-right">{fmt.money(o.feeKop)}</td>
          </tr>
          <tr className="font-semibold">
            <td colSpan={2}>{t('total')}</td>
            <td className="text-right" data-testid="order-total">
              {fmt.money(o.totalKop)}
            </td>
          </tr>
        </tfoot>
      </table>

      {canEdit && (
        <form onSubmit={applyPromo} className="card flex items-start gap-2" noValidate>
          <div className="flex-1">
            <label htmlFor="code">{t('promo')}</label>
            <input id="code" className="field" {...promo.register('code')} />
            {promo.formState.errors.code && (
              <p className="field-error">{promo.formState.errors.code.message}</p>
            )}
          </div>
          <button type="submit" className="btn mt-6" disabled={promo.formState.isSubmitting}>
            {t('apply')}
          </button>
        </form>
      )}

      <ErrorText error={error} />
      {canEdit && (
        <div className="flex gap-3">
          <button className="btn" onClick={pay} data-testid="pay-button">
            {t('pay')}
          </button>
          <button
            className="btn-secondary"
            onClick={() =>
              run(async () => {
                unwrap(await api.DELETE('/api/orders/{id}', { params: { path: { id } } }));
                router.push(`/events/${o.eventId}`);
              })
            }
          >
            {t('release')}
          </button>
        </div>
      )}

      <section>
        <h2 className="mb-1 font-medium">{t('history')}</h2>
        <ul className="space-y-1 text-sm text-gray-700">
          {history.data?.items.map((h) => (
            <li key={h.id}>
              {fmt.dateTime(h.at)} — {h.fromStatus ?? '∅'} → {h.toStatus} ({h.actor}
              {h.note ? `: ${h.note}` : ''})
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
