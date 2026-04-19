import { useEffect, useState } from 'react';
import type { TradeStatus, UserStub } from './useTradeDetail';

export interface TradeListEntry {
  id: string;
  direction: 'sent' | 'received';
  status: TradeStatus;
  counterOfId: string | null;
  offeringCount: number;
  receivingCount: number;
  hasMessage: boolean;
  counterpart: UserStub | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
}

export interface TradesListApi {
  proposals: TradeListEntry[];
  status: 'loading' | 'ready' | 'error';
}

// Module-scoped cache: shared across all hook instances for the lifetime
// of this SPA session. Lets return-navigation to Home render instantly
// with the last-known proposals while a background fetch refreshes them,
// avoiding the "Checking for new proposals…" flash. Cleared on full
// reload, which is the correct TTL for "stale while revalidate" at this
// scope — we don't want to persist to storage and invite stale-data bugs.
let cachedProposals: TradeListEntry[] | null = null;

/** Testing-only: reset the module-scoped cache between test cases. */
export function __resetTradesListCache() {
  cachedProposals = null;
}

/**
 * Lists proposals the signed-in viewer is involved in. Uses a
 * module-scoped stale-while-revalidate cache: first mount fetches
 * fresh; subsequent mounts in the same tab render cached data
 * immediately and refresh in the background.
 */
export function useTradesList(): TradesListApi {
  const [proposals, setProposals] = useState<TradeListEntry[]>(
    () => cachedProposals ?? [],
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    () => (cachedProposals !== null ? 'ready' : 'loading'),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/trades/proposals');
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: { proposals: TradeListEntry[] } = await res.json();
        if (cancelled) return;
        cachedProposals = data.proposals;
        setProposals(data.proposals);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        // If we have cached data, keep showing it rather than flipping
        // to an error state — the user already saw something real.
        if (cachedProposals === null) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { proposals, status };
}
