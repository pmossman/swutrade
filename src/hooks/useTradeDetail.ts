import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../services/apiClient';
import {
  acceptProposal,
  cancelProposal,
  declineProposal,
  nudgeProposal,
  type ActionResult,
} from '../services/tradeActions';

export interface CardSnapshot {
  productId: string;
  name: string;
  variant: string;
  qty: number;
  unitPrice: number | null;
}

export type TradeStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'countered';

export interface UserStub {
  handle: string;
  username: string;
  avatarUrl: string | null;
}

export interface ChainStub {
  id: string;
  status: TradeStatus;
}

export type ProposalEventType =
  | 'created'
  | 'delivered_ok'
  | 'delivered_failed'
  | 'edited'
  | 'nudged'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'countered'
  | 'expired';

export interface ProposalEventActor {
  id: string;
  handle: string;
  username: string;
  avatarUrl: string | null;
}

export interface ProposalEvent {
  id: string;
  type: ProposalEventType;
  actor: ProposalEventActor | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface TradeDetail {
  id: string;
  status: TradeStatus;
  counterOfId: string | null;
  counterOfStub: ChainStub | null;
  counteredByStub: ChainStub | null;
  offeringCards: CardSnapshot[];
  receivingCards: CardSnapshot[];
  message: string | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
  /** Private-thread ids — when set, the proposal was delivered via a
   *  Discord thread rather than per-user DMs. The detail view uses
   *  these to render an "Open in Discord" deep-link. */
  discordThreadId: string | null;
  discordThreadParentChannelId: string | null;
  proposer: UserStub | null;
  recipient: UserStub | null;
  viewerIsProposer: boolean;
  viewerIsRecipient: boolean;
  /** Append-only event log — oldest first. Powers the activity
   *  timeline. Empty for proposals that predate the event table. */
  events: ProposalEvent[];
}

export interface TradeDetailApi {
  trade: TradeDetail | null;
  status: 'loading' | 'ready' | 'not-found' | 'error';
  cancel: () => Promise<ActionResult>;
  cancelling: boolean;
  accept: () => Promise<ActionResult<{ id: string; status: string }>>;
  decline: () => Promise<ActionResult<{ id: string; status: string }>>;
  nudge: (note?: string) => Promise<ActionResult<{ id: string; nudgedAt: string }>>;
  /** True while any of cancel/accept/decline is in flight. Nudge has
   *  its own separate lifecycle since it's a background ping, not a
   *  primary state transition. */
  mutating: boolean;
  reload: () => void;
}

/**
 * Module-scoped cache for fetched proposals. Same shape as
 * `useTradesList`'s cache — stays for the lifetime of the SPA session,
 * cleared on full reload. Lets the inline expand-peek on the My Trades
 * lists flip open instantly on repeat expansions instead of re-fetching
 * every time. Successful mutations invalidate the affected entry via
 * the reload tick, which forces a fresh fetch.
 */
const detailCache = new Map<string, TradeDetail>();

/** Testing-only: reset the module-scoped cache between test cases. */
export function __resetTradeDetailCache() {
  detailCache.clear();
}

/**
 * Loads a single proposal by id. Powers /?trade=<id>. Exposes mutation
 * helpers for every action the viewer might take from the detail view
 * or a row — cancel, accept, decline, nudge — and reloads the trade
 * after a successful mutation so the UI picks up the new status +
 * fresh event on the timeline.
 */
export function useTradeDetail(id: string | null): TradeDetailApi {
  // Seed from cache so cache hits render synchronously — the expand
  // peek opens instantly on repeat expansions. Background fetch still
  // fires to reconcile against the server.
  const [trade, setTrade] = useState<TradeDetail | null>(
    () => (id ? detailCache.get(id) ?? null : null),
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'not-found' | 'error'>(
    () => (id && detailCache.has(id) ? 'ready' : 'loading'),
  );
  const [mutating, setMutating] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!id) {
      setStatus('not-found');
      return;
    }
    // Re-seed when id changes (cached-different or not-yet-cached).
    const cached = detailCache.get(id);
    if (cached) {
      setTrade(cached);
      setStatus('ready');
    } else {
      setTrade(null);
      setStatus('loading');
    }
    let cancelled = false;
    (async () => {
      const result = await apiGet<TradeDetail>(
        `/api/trades/${encodeURIComponent(id)}`,
      );
      if (cancelled) return;
      if (!result.ok) {
        // On a failed revalidation, keep any cached body visible but
        // surface the error status so the caller can decide. New fetches
        // (no cache) go straight to the error branch.
        if (!detailCache.has(id)) {
          setStatus(result.reason === 'not-found' ? 'not-found' : 'error');
        }
        return;
      }
      detailCache.set(id, result.data);
      setTrade(result.data);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, [id, reloadTick]);

  const reload = useCallback(() => setReloadTick(t => t + 1), []);

  const wrap = useCallback(async <T,>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> => {
    if (!id || mutating) return { ok: false, reason: 'error' as const };
    setMutating(true);
    try {
      const result = await fn();
      if (result.ok) {
        // Drop the cache entry first so concurrent consumers don't
        // serve the pre-mutation body. The reload tick triggers a
        // re-fetch that repopulates with the post-mutation state.
        detailCache.delete(id);
        setReloadTick(t => t + 1);
      }
      return result;
    } finally {
      setMutating(false);
    }
  }, [id, mutating]);

  const cancel = useCallback(() => wrap(() => cancelProposal(id ?? '')), [wrap, id]);
  const accept = useCallback(() => wrap(() => acceptProposal(id ?? '')), [wrap, id]);
  const decline = useCallback(() => wrap(() => declineProposal(id ?? '')), [wrap, id]);

  // Nudge is lighter-weight than the other mutations — no status
  // transition, no page flip — so it doesn't share the `mutating`
  // flag. The reload after a successful nudge is what surfaces the
  // new event on the timeline.
  const nudge = useCallback(async (note?: string) => {
    if (!id) return { ok: false as const, reason: 'error' as const };
    const result = await nudgeProposal(id, note);
    if (result.ok) {
      detailCache.delete(id);
      setReloadTick(t => t + 1);
    }
    return result;
  }, [id]);

  return {
    trade,
    status,
    cancel,
    cancelling: mutating,
    accept,
    decline,
    nudge,
    mutating,
    reload,
  };
}
