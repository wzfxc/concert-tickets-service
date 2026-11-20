'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Server-clock countdown: the offset is `serverNow − localNow` taken when the response arrived, so a client clock
 * that is minutes off still shows the right remaining time (invariant 13).
 */
export function useServerCountdown(
  expiresAt: string | undefined,
  serverNow: string | undefined,
): number | null {
  const offset = useRef(0);
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!expiresAt || !serverNow) return;
    offset.current = new Date(serverNow).getTime() - new Date().getTime();
    const tick = (): void =>
      setLeft(new Date(expiresAt).getTime() - (new Date().getTime() + offset.current));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [expiresAt, serverNow]);
  return left;
}
