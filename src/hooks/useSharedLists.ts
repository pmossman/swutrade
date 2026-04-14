import { useState, useEffect } from 'react';
import { decodeWants, decodeAvailable, type WantsUrlEntry, type AvailableUrlEntry } from '../urlCodec';

export interface SharedLists {
  wants: WantsUrlEntry[];
  available: AvailableUrlEntry[];
}

/**
 * Parses ?w= and ?a= from the URL once on mount and returns the
 * decoded sender lists. Null when neither param is present.
 *
 * Doesn't hot-reload as the URL changes — the trade overlay is the
 * primary surface that reads these and we want it stable for the
 * session, not flickering as the user navigates / shares / etc.
 */
export function useSharedLists(): SharedLists | null {
  const [shared, setShared] = useState<SharedLists | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const w = params.get('w');
    const a = params.get('a');
    if (!w && !a) return;
    const decoded: SharedLists = {
      wants: w ? decodeWants(w) : [],
      available: a ? decodeAvailable(a) : [],
    };
    if (decoded.wants.length === 0 && decoded.available.length === 0) return;
    setShared(decoded);
  }, []);

  return shared;
}
