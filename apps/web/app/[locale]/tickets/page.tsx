'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { TransferSchema } from '@tickets/shared';
import { ErrorText, applyServerErrors } from '../../../src/components/ErrorText';
import { useRequireRole } from '../../../src/lib/auth';
import { api, newKey, unwrap } from '../../../src/lib/api';
import { useFormat } from '../../../src/lib/format';

export default function TicketsPage() {
  const t = useTranslations('tickets');
  const tt = useTranslations('status.ticket');
  const tc = useTranslations('common');
  const fmt = useFormat();
  const qc = useQueryClient();
  const ready = useRequireRole('buyer');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [transferring, setTransferring] = useState<string | null>(null);

  const tickets = useQuery({
    queryKey: ['tickets'],
    enabled: ready,
    queryFn: async () => unwrap(await api.GET('/api/tickets')),
  });
  const orders = useQuery({
    queryKey: ['orders'],
    enabled: ready,
    queryFn: async () => unwrap(await api.GET('/api/orders')),
  });
  const form = useForm<{ toEmail: string }>({
    resolver: zodResolver(TransferSchema),
    defaultValues: { toEmail: '' },
  });

  const refund = async (ticketId: string, eventId: string): Promise<void> => {
    setError(null);
    setNotice('');
    try {
      const order = orders.data?.items.find(
        (o) =>
          o.eventId === eventId &&
          o.items.some((i) => !i.refunded) &&
          ['paid', 'partially_refunded'].includes(o.status),
      );
      if (!order) return;
      unwrap(
        await api.POST('/api/orders/{id}/refunds', {
          params: { path: { id: order.id }, header: { 'Idempotency-Key': newKey() } },
          body: { ticketIds: [ticketId] },
        }),
      );
      setNotice(t('refundDone'));
      await qc.invalidateQueries({ queryKey: ['tickets'] });
    } catch (err) {
      setError(err);
    }
  };

  const transfer = form.handleSubmit(async (v) => {
    if (!transferring) return;
    setError(null);
    try {
      unwrap(
        await api.POST('/api/tickets/{id}/transfer', {
          params: { path: { id: transferring }, header: { 'Idempotency-Key': newKey() } },
          body: v,
        }),
      );
      setNotice(t('transferDone'));
      setTransferring(null);
      form.reset();
      await qc.invalidateQueries({ queryKey: ['tickets'] });
    } catch (err) {
      setError(err);
      applyServerErrors(err, form.setError as never);
    }
  });

  if (!ready) return null;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ErrorText error={error} />
      {notice && (
        <p role="status" className="text-green-700">
          {notice}
        </p>
      )}
      {tickets.data && tickets.data.items.length === 0 && <p>{tc('none')}</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {tickets.data?.items.map((tk) => (
          <li key={tk.id} className="card flex gap-3" data-testid="ticket">
            <div className={tk.status === 'valid' ? '' : 'opacity-30'} aria-label={t('qr')}>
              <QRCodeSVG value={tk.qr} size={112} />
            </div>
            <div className="flex-1 text-sm">
              <p className="font-medium">{tk.eventTitle}</p>
              <p>{fmt.dateTime(tk.startsAt)}</p>
              <p>
                {tk.zoneName}
                {tk.row ? ` · ${tk.row}/${tk.number}` : ''}
              </p>
              <p data-testid="ticket-status">{tt(tk.status as 'valid')}</p>
              {tk.status === 'valid' && (
                <div className="mt-2 flex gap-2">
                  <button className="btn-secondary" onClick={() => refund(tk.id, tk.eventId)}>
                    {t('refund')}
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => setTransferring(transferring === tk.id ? null : tk.id)}
                  >
                    {t('transfer')}
                  </button>
                </div>
              )}
              {transferring === tk.id && (
                <form onSubmit={transfer} className="mt-2 space-y-1" noValidate>
                  <label htmlFor="toEmail">{t('toEmail')}</label>
                  <input
                    id="toEmail"
                    type="email"
                    className="field"
                    {...form.register('toEmail')}
                  />
                  {form.formState.errors.toEmail && (
                    <p className="field-error">{form.formState.errors.toEmail.message}</p>
                  )}
                  <button className="btn" type="submit">
                    {t('transfer')}
                  </button>
                </form>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
