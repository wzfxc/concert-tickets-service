'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorText } from '../../../../src/components/ErrorText';
import { SeatMap, type MapSeats } from '../../../../src/components/SeatMap';
import { useRouter } from '../../../../src/i18n/routing';
import { api, newKey, unwrap } from '../../../../src/lib/api';
import { useAuth } from '../../../../src/lib/auth';
import { useServerCountdown } from '../../../../src/lib/clock';
import { formatCountdown, useFormat } from '../../../../src/lib/format';
import { getSocket } from '../../../../src/lib/socket';

const STATE_CODE: Record<string, number> = { free: 0, held: 1, sold: 2, offered: 4 };

interface Change {
  seq: number;
  seatId: number | null;
  zoneId: string | null;
  state: string;
}
interface ResyncAck {
  ok: boolean;
  full?: boolean;
  seq?: number;
  changes?: Change[];
}

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('event');
  const th = useTranslations('hold');
  const tm = useTranslations('map');
  const ts = useTranslations('status.event');
  const fmt = useFormat();
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: async () => unwrap(await api.GET('/api/events/{id}', { params: { path: { id } } })),
  });
  const map = useQuery({
    queryKey: ['map', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/events/{id}/map', { params: { path: { id } } })),
    staleTime: Infinity,
  });

  const [seats, setSeats] = useState<MapSeats | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [qty, setQty] = useState<Record<string, number>>({});
  const [error, setError] = useState<unknown>(null);
  const [live, setLive] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (map.data) {
      setSeats(map.data.seats);
      seqRef.current = map.data.seq;
    }
  }, [map.data]);

  const applyChanges = useCallback(
    (changes: Change[]) => {
      let zoneTouched = false;
      setSeats((cur) => {
        if (!cur) return cur;
        const index = new Map<number, number>();
        cur.ids.forEach((sid, i) => index.set(sid, i));
        const state = [...cur.state];
        for (const c of changes) {
          if (c.seatId === null) {
            zoneTouched = true;
            continue;
          }
          const i = index.get(c.seatId);
          if (i !== undefined) state[i] = STATE_CODE[c.state] ?? 0;
        }
        return { ...cur, state };
      });
      if (zoneTouched) void qc.invalidateQueries({ queryKey: ['map', id] });
    },
    [qc, id],
  );

  // Live updates: apply in seq order, drop duplicates, and resync after a gap or a reconnect.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const resync = (): void => {
      socket.emit('resync', { eventId: id, sinceSeq: seqRef.current }, (ack: ResyncAck) => {
        if (!ack.ok) return;
        if (ack.full) void qc.invalidateQueries({ queryKey: ['map', id] });
        else if (ack.changes?.length) applyChanges(ack.changes);
        if (typeof ack.seq === 'number') seqRef.current = Math.max(seqRef.current, ack.seq);
      });
    };
    const onUpdate = (p: { eventId: string; changes: Change[] }): void => {
      if (p.eventId !== id) return;
      const fresh = p.changes.filter((c) => c.seq > seqRef.current).sort((a, b) => a.seq - b.seq);
      if (!fresh.length) return;
      if (fresh[0]!.seq > seqRef.current + 1) {
        resync();
        return;
      }
      applyChanges(fresh);
      seqRef.current = fresh[fresh.length - 1]!.seq;
    };
    const onStatus = (): void => void qc.invalidateQueries({ queryKey: ['event', id] });
    const subscribe = (): void => {
      socket.emit('subscribe', { eventId: id }, () => {
        setLive(true);
        resync();
      });
    };
    const onDown = (): void => setLive(false);
    socket.on('seat:update', onUpdate);
    socket.on('event:status', onStatus);
    socket.on('connect', subscribe);
    socket.on('disconnect', onDown);
    if (socket.connected) subscribe();
    return () => {
      socket.emit('unsubscribe', { eventId: id });
      socket.off('seat:update', onUpdate);
      socket.off('event:status', onStatus);
      socket.off('connect', subscribe);
      socket.off('disconnect', onDown);
    };
  }, [id, qc, applyChanges, user?.id]);

  // Queue and waitlist state (buyers only)
  const isBuyer = user?.role === 'buyer';
  const queue = useQuery({
    queryKey: ['queue', id],
    enabled: isBuyer && !!event.data?.queueActive,
    queryFn: async () =>
      unwrap(await api.GET('/api/events/{id}/queue', { params: { path: { id } } })),
    refetchInterval: 4000,
  });
  const waitlist = useQuery({
    queryKey: ['waitlist', id],
    enabled: isBuyer,
    queryFn: async () =>
      unwrap(await api.GET('/api/events/{id}/waitlist', { params: { path: { id } } })),
    refetchInterval: 8000,
  });
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const refresh = (): void => {
      void qc.invalidateQueries({ queryKey: ['queue', id] });
      void qc.invalidateQueries({ queryKey: ['waitlist', id] });
    };
    socket.on('queue:update', refresh);
    socket.on('waitlist:offer', refresh);
    return () => {
      socket.off('queue:update', refresh);
      socket.off('waitlist:offer', refresh);
    };
  }, [id, qc, user?.id]);

  const admitLeft = useServerCountdown(
    queue.data?.admitExpiresAt ?? undefined,
    queue.data?.serverNow,
  );
  const offerLeft = useServerCountdown(
    waitlist.data?.offerExpiresAt ?? undefined,
    event.data?.serverNow,
  );

  const ev = event.data;
  const waitingInQueue = !!ev?.queueActive && queue.data?.status !== 'admitted';
  const offered = useMemo(() => new Set(waitlist.data?.offeredSeatIds ?? []), [waitlist.data]);

  const toggle = (seatId: number): void => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(seatId)) next.delete(seatId);
      else if (next.size < (ev?.perUserLimit ?? 6)) next.add(seatId);
      return next;
    });
  };

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    }
  };

  const hold = (): Promise<void> =>
    run(async () => {
      const zones = Object.entries(qty)
        .filter(([, q]) => q > 0)
        .map(([zoneId, quantity]) => ({ zoneId, quantity }));
      const order = unwrap(
        await api.POST('/api/holds', {
          params: { header: { 'Idempotency-Key': newKey() } },
          body: { eventId: id, seatIds: [...selected], zones },
        }),
      );
      router.push(`/orders/${order.id}`);
    });

  const price = useMemo(() => {
    if (!seats || !ev) return 0;
    let sum = 0;
    seats.ids.forEach((sid, i) => {
      if (selected.has(sid)) sum += seats.priceKop[i] ?? 0;
    });
    for (const z of ev.zones)
      if (z.kind === 'dancefloor') sum += (qty[z.id] ?? 0) * (z.priceKop ?? 0);
    return sum;
  }, [seats, selected, qty, ev]);
  const count = selected.size + Object.values(qty).reduce((a, b) => a + b, 0);

  if (event.error) return <ErrorText error={event.error} />;
  if (!ev) return <p>…</p>;
  const soldOut = ev.status === 'sold_out';

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{ev.title}</h1>
        <p className="text-sm text-gray-600">
          {ev.city} · {ev.category} · {ts(ev.status)}
        </p>
        <p className="text-sm">{t('starts', { date: fmt.dateTime(ev.startsAt) })}</p>
        {ev.salesStart && (
          <p className="text-sm">{t('salesStart', { date: fmt.dateTime(ev.salesStart) })}</p>
        )}
        <p className="text-sm">{t('perUserLimit', { count: ev.perUserLimit })}</p>
        {ev.rescheduledAt && <p className="text-sm text-amber-700">{t('rescheduled')}</p>}
        <p className="text-xs text-gray-500" aria-live="polite">
          {live ? t('connected') : t('disconnected')}
        </p>
      </header>

      <section className="card">
        <h2 className="mb-2 font-medium">{t('zones')}</h2>
        <ul className="space-y-1 text-sm">
          {ev.zones.map((z) => (
            <li key={z.id}>
              {z.name} — {z.priceKop !== null ? fmt.money(z.priceKop) : '—'}
            </li>
          ))}
        </ul>
      </section>

      {!user && <p className="card text-sm">{th('login')}</p>}

      {isBuyer && ev.queueActive && (
        <section className="card space-y-2" data-testid="queue-panel">
          <h2 className="font-medium">{th('queueTitle')}</h2>
          {(!queue.data ||
            queue.data.status === 'left' ||
            queue.data.status === 'expired' ||
            queue.data.status === 'done') && (
            <>
              {queue.data?.status === 'expired' && (
                <p className="text-sm text-amber-700">{th('queueExpired')}</p>
              )}
              <button
                className="btn"
                onClick={() =>
                  run(async () => {
                    unwrap(await api.POST('/api/events/{id}/queue', { params: { path: { id } } }));
                    await qc.invalidateQueries({ queryKey: ['queue', id] });
                  })
                }
              >
                {th('queueJoin')}
              </button>
            </>
          )}
          {queue.data?.status === 'waiting' && (
            <>
              <p data-testid="queue-position">
                {th('queuePosition', { position: queue.data.position ?? 0 })}
              </p>
              {queue.data.estimatedWaitSeconds !== null && (
                <p className="text-sm text-gray-600">
                  {th('queueEta', {
                    minutes: Math.max(1, Math.ceil(queue.data.estimatedWaitSeconds / 60)),
                  })}
                </p>
              )}
            </>
          )}
          {queue.data?.status === 'admitted' && (
            <p data-testid="queue-admitted">
              {th('queueAdmitted', { time: formatCountdown(admitLeft ?? 0) })}
            </p>
          )}
          {(queue.data?.status === 'waiting' || queue.data?.status === 'admitted') && (
            <button
              className="btn-secondary"
              onClick={() =>
                run(async () => {
                  unwrap(await api.DELETE('/api/events/{id}/queue', { params: { path: { id } } }));
                  await qc.invalidateQueries({ queryKey: ['queue', id] });
                })
              }
            >
              {th('queueLeave')}
            </button>
          )}
        </section>
      )}

      {isBuyer && soldOut && (
        <section className="card space-y-2" data-testid="waitlist-panel">
          <h2 className="font-medium">{th('waitlistTitle')}</h2>
          {(!waitlist.data ||
            waitlist.data.status === 'left' ||
            waitlist.data.status === 'done') && (
            <button
              className="btn"
              onClick={() =>
                run(async () => {
                  unwrap(
                    await api.POST('/api/events/{id}/waitlist', {
                      params: { path: { id } },
                      body: { quantity: 1 },
                    }),
                  );
                  await qc.invalidateQueries({ queryKey: ['waitlist', id] });
                })
              }
            >
              {th('waitlistJoin')}
            </button>
          )}
          {waitlist.data?.status === 'waiting' && <p>{th('waitlistWaiting')}</p>}
          {waitlist.data?.status === 'offered' && (
            <p data-testid="waitlist-offer">
              {th('waitlistOffer', { time: formatCountdown(offerLeft ?? 0) })}
            </p>
          )}
          {(waitlist.data?.status === 'waiting' || waitlist.data?.status === 'offered') && (
            <button
              className="btn-secondary"
              onClick={() =>
                run(async () => {
                  unwrap(
                    await api.DELETE('/api/events/{id}/waitlist', { params: { path: { id } } }),
                  );
                  await qc.invalidateQueries({ queryKey: ['waitlist', id] });
                })
              }
            >
              {th('waitlistLeave')}
            </button>
          )}
        </section>
      )}

      <section className="space-y-3" aria-label={t('live')}>
        <h2 className="font-medium">{t('live')}</h2>
        {seats && seats.ids.length > 0 && (
          <SeatMap
            seats={seats}
            selected={selected}
            onToggle={toggle}
            disabled={!isBuyer || waitingInQueue}
          />
        )}
        {offered.size > 0 && (
          <p className="text-xs text-violet-700">
            {tm('offered')}: {offered.size}
          </p>
        )}
        {map.data?.zones
          .filter((z) => z.kind === 'dancefloor')
          .map((z) => {
            const left = Math.max(0, (z.capacity ?? 0) - z.taken);
            return (
              <div key={z.id} className="card flex items-center gap-3">
                <div className="flex-1">
                  <p className="font-medium">
                    {tm('dancefloor')}: {z.name}
                  </p>
                  <p className="text-sm text-gray-600">
                    {tm('dancefloorLeft', { left, capacity: z.capacity ?? 0 })}
                  </p>
                </div>
                <label htmlFor={`q-${z.id}`} className="text-sm">
                  {tm('quantity')}
                </label>
                <input
                  id={`q-${z.id}`}
                  type="number"
                  min={0}
                  max={Math.min(left, ev.perUserLimit)}
                  className="field w-20"
                  value={qty[z.id] ?? 0}
                  disabled={!isBuyer || waitingInQueue}
                  onChange={(e) =>
                    setQty({ ...qty, [z.id]: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </div>
            );
          })}
      </section>

      <ErrorText error={error} />
      {isBuyer && (
        <div className="card flex flex-wrap items-center gap-3">
          <span>{count > 0 ? th('selected', { count }) : th('none')}</span>
          {count > 0 && (
            <span className="font-medium">{th('total', { price: fmt.money(price) })}</span>
          )}
          <button
            className="btn ml-auto"
            disabled={count === 0 || waitingInQueue}
            onClick={hold}
            data-testid="hold-button"
          >
            {th('button')}
          </button>
        </div>
      )}
    </div>
  );
}
