import { useState } from 'react';

/**
 * Captures `?propose=<handle>` from the initial URL. Paired with
 * ProposeBar to drive the "compose a trade proposal" mode on the
 * main trade view.
 *
 * Uses a lazy initializer (not useEffect) because `useTradeUrl`
 * rewrites the search params shortly after mount, stripping
 * anything that's not a trade param. See the diagnostic playbook
 * entry in PHASE4_TESTING.md — we hit the same trap with
 * `autoBalance=1` earlier and this is the same workaround.
 */
export function useProposeHandle(): string | null {
  const [handle] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('propose');
    if (!raw) return null;
    const trimmed = raw.trim().replace(/^@/, '');
    return trimmed || null;
  });
  return handle;
}
