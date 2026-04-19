import { useEffect, useState } from 'react';
import { decodeWants, decodeAvailable, type WantsUrlEntry, type AvailableUrlEntry } from '../urlCodec';

export interface SharedLists {
  wants: WantsUrlEntry[];
  available: AvailableUrlEntry[];
}

/** Pure URL → SharedLists parse. Returns null when neither ?w= nor ?a=
 *  is present or when both decode to empty arrays. Exported for
 *  parity with the other URL-backed hooks and so tests can validate
 *  the parse without a React runtime. */
export function parseSharedListsFromSearch(search: string): SharedLists | null {
  const params = new URLSearchParams(search);
  const w = params.get('w');
  const a = params.get('a');
  if (!w && !a) return null;
  const decoded: SharedLists = {
    wants: w ? decodeWants(w) : [],
    available: a ? decodeAvailable(a) : [],
  };
  if (decoded.wants.length === 0 && decoded.available.length === 0) return null;
  return decoded;
}

/**
 * Decoded sender lists from ?w= / ?a=. Same seed-on-mount + popstate
 * re-sync contract as useTradeIntent, kept as its own hook because the
 * payload is structured (arrays of entries) rather than scalar. In-app
 * navigation doesn't normally push new w/a URLs — the share flow is
 * reload-mounted — so the popstate listener is mostly defensive, but
 * keeping the contract uniform means we don't need a second mental
 * model for "URL-backed hook that might or might not listen."
 */
export function useSharedLists(): SharedLists | null {
  const [shared, setShared] = useState<SharedLists | null>(
    () => (typeof window === 'undefined' ? null : parseSharedListsFromSearch(window.location.search)),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => setShared(parseSharedListsFromSearch(window.location.search));
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  return shared;
}
