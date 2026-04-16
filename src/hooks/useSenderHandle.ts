import { useState } from 'react';

/**
 * Parses `?from=<handle>` from the URL once on mount. When a
 * signed-in user shares a list or trade, the share URL gains this
 * param so the recipient knows who sent it.
 *
 * Uses a lazy initializer (not useEffect) so the handle is available
 * on the first render — downstream components like MatchmakerInput
 * rely on it for their own useState initial values, which only
 * consult props on mount. Captured once; useTradeUrl rewrites the
 * search params during normal interaction and we don't want the
 * sender context to flicker away mid-session.
 */
export function useSenderHandle(): string | null {
  const [handle] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const from = params.get('from');
    if (!from) return null;
    const trimmed = from.trim().replace(/^@/, '');
    return trimmed || null;
  });

  return handle;
}
