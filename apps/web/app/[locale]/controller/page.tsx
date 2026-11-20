'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorText } from '../../../src/components/ErrorText';
import { ApiError, api, unwrap } from '../../../src/lib/api';
import { useRequireRole } from '../../../src/lib/auth';
import { useFormat } from '../../../src/lib/format';

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
interface DetectorCtor {
  new (opts: { formats: string[] }): Detector;
}

export default function ControllerPage() {
  const t = useTranslations('ctrl');
  const tm = useTranslations('map');
  const fmt = useFormat();
  const qc = useQueryClient();
  const ready = useRequireRole('controller');
  const [eventId, setEventId] = useState('');
  const [gate, setGate] = useState('A');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<{
    zoneName: string;
    row: string | null;
    number: number | null;
  } | null>(null);
  const [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const busy = useRef(false);

  const events = useQuery({
    queryKey: ['ctrl-events'],
    enabled: ready,
    queryFn: async () => unwrap(await api.GET('/api/controller/events')),
  });
  const stats = useQuery({
    queryKey: ['gate-stats', eventId],
    enabled: !!eventId,
    refetchInterval: 3000,
    queryFn: async () =>
      unwrap(await api.GET('/api/events/{id}/gate-stats', { params: { path: { id: eventId } } })),
  });

  const check = useCallback(
    async (value: string): Promise<void> => {
      if (!eventId || !value || busy.current) return;
      busy.current = true;
      setError(null);
      setOk(null);
      try {
        const res = unwrap(
          await api.POST('/api/scan', { body: { eventId, code: value, gate: gate || 'A' } }),
        );
        setOk({ zoneName: res.zoneName, row: res.row, number: res.number });
        setCode('');
        await qc.invalidateQueries({ queryKey: ['gate-stats', eventId] });
      } catch (err) {
        setError(err);
      } finally {
        busy.current = false;
      }
    },
    [eventId, gate, qc],
  );

  // Camera scanning through BarcodeDetector where the browser has it; manual entry always works.
  const Detector =
    typeof window !== 'undefined'
      ? (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
      : undefined;
  useEffect(() => {
    if (!camera || !Detector) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      stream = s;
      const el = video.current;
      if (!el) return;
      el.srcObject = s;
      void el.play();
      const detector = new Detector({ formats: ['qr_code'] });
      timer = setInterval(() => {
        void detector.detect(el).then((found) => {
          if (found[0]) void check(found[0].rawValue);
        });
      }, 500);
    });
    return () => {
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [camera, Detector, check]);

  if (!ready) return null;
  const used =
    error instanceof ApiError && error.code === 'ALREADY_USED' ? error.details : undefined;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <div className="card space-y-2">
        <label htmlFor="ctrl-event">{t('event')}</label>
        <select
          id="ctrl-event"
          className="field"
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
        >
          <option value="" />
          {events.data?.items.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title} — {fmt.dateTime(e.startsAt)}
            </option>
          ))}
        </select>
        <label htmlFor="ctrl-gate">{t('gate')}</label>
        <input
          id="ctrl-gate"
          className="field"
          value={gate}
          maxLength={20}
          onChange={(e) => setGate(e.target.value)}
        />
      </div>

      {stats.data && (
        <p className="card text-lg" data-testid="gate-stats">
          {t('admitted', { count: stats.data.admitted })} ·{' '}
          {t('remaining', { count: stats.data.remaining })}
        </p>
      )}

      <form
        className="card space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void check(code.trim());
        }}
      >
        <label htmlFor="ctrl-code">{t('code')}</label>
        <input
          id="ctrl-code"
          className="field font-mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
        />
        <div className="flex gap-2">
          <button className="btn" type="submit" disabled={!eventId || !code}>
            {t('scan')}
          </button>
          {Detector ? (
            <button type="button" className="btn-secondary" onClick={() => setCamera(!camera)}>
              {camera ? t('stop') : t('camera')}
            </button>
          ) : (
            <p className="text-xs text-gray-500">{t('noCamera')}</p>
          )}
        </div>
        {camera && <video ref={video} className="w-full rounded" muted playsInline />}
      </form>

      {ok && (
        <p
          role="status"
          className="rounded bg-green-100 p-4 text-xl font-semibold text-green-900"
          data-testid="scan-ok"
        >
          {t('admit')} — {ok.zoneName}
          {ok.row ? ` · ${tm('seat', { row: ok.row, number: ok.number ?? 0 })}` : ''}
        </p>
      )}
      {used && typeof used['usedAt'] === 'string' && (
        <p role="alert" className="text-sm text-red-700">
          {t('usedAt', { time: fmt.time(used['usedAt']), gate: String(used['gate'] ?? '') })}
        </p>
      )}
      <ErrorText error={error} />
    </div>
  );
}
