import { useState } from 'react';

/**
 * Captures `?counter=<tradeId>` from the initial URL. Paired with
 * CounterBar to drive the counter-compose mode on the main trade view.
 *
 * Lazy initializer (not useEffect) because useTradeUrl strips non-
 * trade params shortly after mount — same pattern as
 * useProposeHandle + AutoBalanceBanner's autoBalance detection.
 */
export function useCounterId(): string | null {
  const [id] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = new URLSearchParams(window.location.search).get('counter');
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed || null;
  });
  return id;
}
