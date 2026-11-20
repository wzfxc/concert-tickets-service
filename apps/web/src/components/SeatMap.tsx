'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface MapSeats {
  ids: number[];
  zoneIdx: number[];
  rows: string[];
  numbers: number[];
  x: number[];
  y: number[];
  state: number[];
  priceKop: number[];
}

/** 0 free, 1 held, 2 sold, 3 blocked, 4 offered (same codes as the API). */
const COLORS = ['#86efac', '#fbbf24', '#9ca3af', '#4b5563', '#c4b5fd'] as const;
const SELECTED = '#4f46e5';
const CELL = 20;
const PAD = 12;
const VIEW_H = 460;

interface Props {
  seats: MapSeats;
  selected: ReadonlySet<number>;
  onToggle: (seatId: number) => void;
  disabled?: boolean;
}

/**
 * Canvas seat map. Only the visible window is drawn (virtualised via a sticky canvas inside a scroll container), so
 * 10 000 seats scroll without long frames. Fully keyboard-operable: arrows move a cursor, Enter/Space toggles.
 */
export function SeatMap({ seats, selected, onToggle, disabled }: Props) {
  const t = useTranslations('map');
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cursor, setCursor] = useState(0);
  const [announce, setAnnounce] = useState('');
  const raf = useRef<number | null>(null);
  const [width, setWidth] = useState(800);

  const grid = useMemo(() => {
    const byCell = new Map<string, number>();
    let maxX = 0;
    let maxY = 0;
    seats.ids.forEach((_, i) => {
      const cx = Math.round(seats.x[i]!);
      const cy = Math.round(seats.y[i]!);
      byCell.set(`${cx}:${cy}`, i);
      maxX = Math.max(maxX, cx);
      maxY = Math.max(maxY, cy);
    });
    return { byCell, w: (maxX + 1) * CELL + PAD * 2, h: (maxY + 1) * CELL + PAD * 2 };
  }, [seats.ids, seats.x, seats.y]);

  const counts = useMemo(() => {
    const c = [0, 0, 0, 0, 0];
    for (const s of seats.state) c[s] = (c[s] ?? 0) + 1;
    return c;
  }, [seats.state]);

  const draw = useCallback(() => {
    const cv = canvas.current;
    const sc = scroller.current;
    if (!cv || !sc) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const left = sc.scrollLeft;
    const top = sc.scrollTop;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (let i = 0; i < seats.ids.length; i++) {
      const px = PAD + Math.round(seats.x[i]!) * CELL - left;
      const py = PAD + Math.round(seats.y[i]!) * CELL - top;
      if (px < -CELL || py < -CELL || px > cv.width || py > cv.height) continue; // culled
      const id = seats.ids[i]!;
      ctx.fillStyle = selected.has(id) ? SELECTED : (COLORS[seats.state[i]!] ?? COLORS[0]);
      ctx.fillRect(px, py, CELL - 3, CELL - 3);
      if (seats.state[i] === 3) {
        ctx.strokeStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(px + 3, py + 3);
        ctx.lineTo(px + CELL - 6, py + CELL - 6);
        ctx.stroke();
      }
      if (i === cursor) {
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = 2;
        ctx.strokeRect(px - 1, py - 1, CELL - 1, CELL - 1);
        ctx.lineWidth = 1;
      }
    }
  }, [seats, selected, cursor]);

  const schedule = useCallback(() => {
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const resize = (): void => setWidth(sc.clientWidth);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);
  useEffect(schedule, [schedule, width]);

  const describe = useCallback(
    (i: number): string => {
      const names = [t('free'), t('held'), t('sold'), t('blocked'), t('offered')];
      const seat = t('seat', { row: seats.rows[i] ?? '', number: seats.numbers[i] ?? 0 });
      const state = selected.has(seats.ids[i]!) ? t('selected') : (names[seats.state[i]!] ?? '');
      return t('seatState', { seat, state });
    },
    [t, seats, selected],
  );

  const toggle = (i: number): void => {
    if (disabled) return;
    const s = seats.state[i];
    const id = seats.ids[i]!;
    if (s === 0 || selected.has(id)) onToggle(id);
    setAnnounce(describe(i));
  };

  const reveal = (i: number): void => {
    const sc = scroller.current;
    if (!sc) return;
    const px = PAD + Math.round(seats.x[i]!) * CELL;
    const py = PAD + Math.round(seats.y[i]!) * CELL;
    if (px < sc.scrollLeft + CELL || px > sc.scrollLeft + sc.clientWidth - 2 * CELL)
      sc.scrollLeft = px - sc.clientWidth / 2;
    if (py < sc.scrollTop + CELL || py > sc.scrollTop + VIEW_H - 2 * CELL)
      sc.scrollTop = py - VIEW_H / 2;
  };

  const move = (dx: number, dy: number): void => {
    const cx = Math.round(seats.x[cursor]!);
    const cy = Math.round(seats.y[cursor]!);
    let best = -1;
    let bestScore = Infinity;
    // nearest seat in the pressed direction (rows are usually dense, so the adjacent cell wins immediately)
    const adjacent = grid.byCell.get(`${cx + dx}:${cy + dy}`);
    if (adjacent !== undefined) best = adjacent;
    else {
      for (let i = 0; i < seats.ids.length; i++) {
        const ox = Math.round(seats.x[i]!) - cx;
        const oy = Math.round(seats.y[i]!) - cy;
        if (dx !== 0 ? Math.sign(ox) !== dx : Math.sign(oy) !== dy) continue;
        const score = dx !== 0 ? Math.abs(ox) + Math.abs(oy) * 4 : Math.abs(oy) + Math.abs(ox) * 4;
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    if (best >= 0) {
      setCursor(best);
      reveal(best);
      setAnnounce(describe(best));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowRight') move(1, 0);
    else if (e.key === 'ArrowLeft') move(-1, 0);
    else if (e.key === 'ArrowDown') move(0, 1);
    else if (e.key === 'ArrowUp') move(0, -1);
    else if (e.key === 'Enter' || e.key === ' ') toggle(cursor);
    else return;
    e.preventDefault();
  };

  const onClick = (e: React.MouseEvent): void => {
    const sc = scroller.current;
    if (!sc) return;
    const rect = sc.getBoundingClientRect();
    const cx = Math.floor((e.clientX - rect.left + sc.scrollLeft - PAD) / CELL);
    const cy = Math.floor((e.clientY - rect.top + sc.scrollTop - PAD) / CELL);
    const i = grid.byCell.get(`${cx}:${cy}`);
    if (i !== undefined) {
      setCursor(i);
      toggle(i);
    }
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-3 text-xs" aria-hidden="true">
        {[t('free'), t('held'), t('sold'), t('blocked'), t('offered')].map((label, i) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ background: COLORS[i] }} />
            {label} ({counts[i]})
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: SELECTED }} />
          {t('selected')} ({selected.size})
        </span>
      </div>
      <div
        ref={scroller}
        role="application"
        aria-label={t('label')}
        tabIndex={0}
        data-testid="seat-map"
        data-held={counts[1]}
        data-sold={counts[2]}
        data-free={counts[0]}
        data-selected={selected.size}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onScroll={schedule}
        onFocus={() => setAnnounce(describe(cursor))}
        className="relative overflow-auto rounded border bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
        style={{ height: VIEW_H }}
      >
        <div style={{ width: grid.w, height: grid.h }} />
        <canvas
          ref={canvas}
          width={Math.max(width, 100)}
          height={VIEW_H}
          className="pointer-events-none"
          style={{ position: 'sticky', top: 0, left: 0, marginTop: -grid.h, display: 'block' }}
        />
      </div>
      <div className="sr-only" aria-live="polite" data-testid="seat-announce">
        {announce}
      </div>
    </div>
  );
}
