import { useCallback, useEffect, useState } from 'react';
import type { TradeStatus, UserStub } from './useTradeDetail';

export interface TradeListEntry {
  id: string;
  direction: 'sent' | 'received';
  status: TradeStatus;
  counterOfId: string | null;
  offeringCount: number;
  receivingCount: number;
  hasMessage: boolean;
  /** Highest-priced card across both sides — a preview so repeat rows
   *  from the same counterpart don't all look identical in dense lists. */
  topCard: { name: string; variant: string } | null;
  counterpart: UserStub | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
}

/** Narrow event-type union for the Home activity feed. Tracks the
 *  server's `noisyTypes` filter — delivery + creation events are
 *  stripped before the payload ships, so the client never sees them. */
export type TradeActivityType =
  | 'edited'
  | 'nudged'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'countered'
  | 'expired';

export interface TradeActivityEntry {
  type: TradeActivityType;
  /** Who performed the action. Null only for system-initiated events
   *  (e.g. `expired` from the cron). */
  actor: (UserStub & { id: string }) | null;
  proposalId: string;
  createdAt: string;
  /** The viewer's counterpart on the proposal — useful for rendering
   *  "@alice accepted your proposal" when the actor *is* the counterpart. */
  counterpartHandle: string | null;
}

export interface TradesListApi {
  proposals: TradeListEntry[];
  /** 5 most recent non-noisy proposal events across the viewer's
   *  proposals, newest first. Powers the Home "My Trades" activity
   *  preview. Empty array when the user has no qualifying events. */
  recentActivity: TradeActivityEntry[];
  status: 'loading' | 'ready' | 'error';
  /** Force a fresh fetch. Call after a mutation (cancel/accept/etc.)
   *  so the row disappears or flips status without the user navigating
   *  away and back. Updates both the hook's state and the shared cache. */
  refresh: () => Promise<void>;
}

// Module-scoped cache: shared across all hook instances for the lifetime
// of this SPA session. Lets return-navigation to Home render instantly
// with the last-known proposals while a background fetch refreshes them,
// avoiding the "Checking for new proposals…" flash. Cleared on full
// reload, which is the correct TTL for "stale while revalidate" at this
// scope — we don't want to persist to storage and invite stale-data bugs.
interface TradesCache {
  proposals: TradeListEntry[];
  recentActivity: TradeActivityEntry[];
}
let cachedTrades: TradesCache | null = null;

/** Testing-only: reset the module-scoped cache between test cases. */
export function __resetTradesListCache() {
  cachedTrades = null;
}

/**
 * Lists proposals the signed-in viewer is involved in. Uses a
 * module-scoped stale-while-revalidate cache: first mount fetches
 * fresh; subsequent mounts in the same tab render cached data
 * immediately and refresh in the background.
 */
export function useTradesList(): TradesListApi {
  const [proposals, setProposals] = useState<TradeListEntry[]>(
    () => cachedTrades?.proposals ?? [],
  );
  const [recentActivity, setRecentActivity] = useState<TradeActivityEntry[]>(
    () => cachedTrades?.recentActivity ?? [],
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    () => (cachedTrades !== null ? 'ready' : 'loading'),
  );

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch('/api/trades/proposals');
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data: {
        proposals: TradeListEntry[];
        // `recentActivity` may be absent in older deploys (the field
        // shipped alongside the Home 2.0 rework). Tolerate its absence
        // by defaulting to an empty list rather than crashing.
        recentActivity?: TradeActivityEntry[];
      } = await res.json();
      const activity = data.recentActivity ?? [];
      cachedTrades = { proposals: data.proposals, recentActivity: activity };
      setProposals(data.proposals);
      setRecentActivity(activity);
      setStatus('ready');
    } catch {
      // If we have cached data, keep showing it rather than flipping
      // to an error state — the user already saw something real.
      if (cachedTrades === null) setStatus('error');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await fetchOnce();
    })();
    return () => { cancelled = true; };
  }, [fetchOnce]);

  return { proposals, recentActivity, status, refresh: fetchOnce };
}
