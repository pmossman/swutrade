import { useState } from 'react';

/**
 * Captures `?edit=<tradeId>` from the initial URL. Paired with EditBar
 * to drive the edit-in-place composer on the main trade view.
 *
 * Lazy initializer (not useEffect) because useTradeUrl strips non-
 * trade params shortly after mount — same pattern as useCounterId.
 */
export function useEditId(): string | null {
  const [id] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = new URLSearchParams(window.location.search).get('edit');
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed || null;
  });
  return id;
}
