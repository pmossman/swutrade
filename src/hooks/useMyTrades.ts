import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet } from '../services/apiClient';
import { createSingletonCache } from './sharedCache';
import type { TradeListEntry } from './useTradesList';
import type { SessionView, SessionStatus } from './useSession';

/**
 * Client-side view layer that unifies proposals + sessions into a
 * single stream for the Home "My Trades" module. Every row — whether
 * it started life as a proposal (commit-first, Discord-DM) or a
 * session (collaborative, live-or-async) — renders the same way in
 * a list: counterpart identity, state badge, card counts, last
 * activity. The list doesn't care which table the row came from;
 * callers branch on `kind` only when they need kind-specific actions
 * (expand peek shape, deep-link URL).
 *
 * This realizes the Phase 5b vision's "one first-class trade object
 * with state-driven UI" at the UX boundary. Storage stays split
 * (trade_proposals + trade_sessions); the merge is at read-time.
 * A physical table merge is a later decision if the separation ever
 * hurts us.
 */
export type TradeRowState =
  /** Session with both slots filled, still active. */
  | 'shared'
  /** Session with slot B open — creator waiting on a QR scan. */
  | 'shared-waiting'
  /** Proposal pending, viewer is proposer — their pitch is out. */
  | 'pitched'
  /** Proposal pending, viewer is recipient — needs their response. */
  | 'awaiting'
  /** Session settled or proposal accepted. */
  | 'settled'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'countered'
  /** Proposal converted into a shared trade session — the session
   *  surfaces under `shared` separately; the proposal row is the
   *  terminal "this became X" record. */
  | 'promoted';

export interface TradeRowCounterpart {
  userId: string;
  handle: string;
  username: string;
  avatarUrl: string | null;
  isAnonymous?: boolean;
}

export interface TradeRow {
  /** Backing-store discriminator. UI uses this to pick the expand-
   *  peek component + deep-link URL shape. */
  kind: 'session' | 'proposal';
  /** Session short-code or proposal uuid. */
  id: string;
  state: TradeRowState;
  counterpart: TradeRowCounterpart | null;
  yourCount: number;
  theirCount: number;
  /** ISO timestamp — sort key for the unified list. */
  lastActivityAt: string;
  // session-only —————
  /** True when this is a session whose slot B is still open (QR-only
   *  sharing, no claim yet). */
  openSlot?: boolean;
  // proposal-only —————
  direction?: 'sent' | 'received';
  topCard?: { name: string; variant: string } | null;
  hasMessage?: boolean;
  counterOfId?: string | null;
}

export interface MyTradesApi {
  rows: TradeRow[];
  /** Pending proposals received by the viewer — the "needs your
   *  response" callout reads these. Kept separate because the
   *  callout has a distinct IA role (attention-grabbing vs
   *  informational list), not just a filter. */
  needsResponse: TradeRow[];
  /** Counts used by the existing activity module summary. Derived
   *  purely from the merged list — removes the need for a second
   *  server fetch when we migrate the summary too. */
  counts: { incoming: number; outgoing: number; resolved: number; activeSessions: number };
  status: 'loading' | 'ready' | 'error';
  refresh: () => Promise<void>;
}

interface CachedShape {
  rows: TradeRow[];
}
const cache = createSingletonCache<CachedShape>();

/** Testing-only reset. */
export function __resetMyTradesCache() {
  cache.clear();
}

export function useMyTrades(): MyTradesApi {
  const [rows, setRows] = useState<TradeRow[]>(
    () => cache.get()?.rows ?? [],
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    () => (cache.has() ? 'ready' : 'loading'),
  );

  const fetchOnce = useCallback(async () => {
    // Fire both fetches in parallel — they're independent and
    // there's no reason to block one on the other.
    const [proposalsResult, sessionsResult] = await Promise.all([
      apiGet<{ proposals: TradeListEntry[] }>('/api/trades/proposals'),
      apiGet<{ sessions: SessionView[] }>('/api/me/sessions'),
    ]);

    if (!proposalsResult.ok || !sessionsResult.ok) {
      if (!cache.has()) setStatus('error');
      return;
    }

    const fromProposals = proposalsResult.data.proposals.map(proposalToRow);
    const fromSessions = sessionsResult.data.sessions.map(sessionToRow);

    const merged = [...fromProposals, ...fromSessions].sort(
      (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
    cache.set({ rows: merged });
    setRows(merged);
    setStatus('ready');
  }, []);

  useEffect(() => {
    fetchOnce();
  }, [fetchOnce]);

  const needsResponse = useMemo(
    () => rows.filter(r => r.state === 'awaiting'),
    [rows],
  );

  const counts = useMemo(() => {
    let incoming = 0;
    let outgoing = 0;
    let resolved = 0;
    let activeSessions = 0;
    for (const r of rows) {
      if (r.kind === 'session') {
        if (r.state === 'shared' || r.state === 'shared-waiting') activeSessions += 1;
        else if (r.state === 'settled' || r.state === 'cancelled' || r.state === 'expired') resolved += 1;
        continue;
      }
      // proposal
      if (r.state === 'awaiting') incoming += 1;
      else if (r.state === 'pitched') outgoing += 1;
      else resolved += 1;
    }
    return { incoming, outgoing, resolved, activeSessions };
  }, [rows]);

  return { rows, needsResponse, counts, status, refresh: fetchOnce };
}

// --- normalizers ----------------------------------------------------------

function proposalToRow(p: TradeListEntry): TradeRow {
  // State mapping from the proposal status + viewer direction. The
  // key one: pending + received = 'awaiting' (UI highlights), pending
  // + sent = 'pitched' (UI just shows as outgoing).
  const state: TradeRowState =
    p.status === 'pending'
      ? p.direction === 'received' ? 'awaiting' : 'pitched'
      : (p.status as TradeRowState);

  return {
    kind: 'proposal',
    id: p.id,
    state,
    counterpart: p.counterpart
      ? {
          userId: p.counterpart.handle, // TradeListEntry stores handle-only as identity
          handle: p.counterpart.handle,
          username: p.counterpart.username,
          avatarUrl: p.counterpart.avatarUrl,
        }
      : null,
    yourCount: p.direction === 'sent' ? p.offeringCount : p.receivingCount,
    theirCount: p.direction === 'sent' ? p.receivingCount : p.offeringCount,
    lastActivityAt: p.updatedAt,
    direction: p.direction,
    topCard: p.topCard,
    hasMessage: p.hasMessage,
    counterOfId: p.counterOfId,
  };
}

function sessionToRow(s: SessionView): TradeRow {
  const state: TradeRowState = sessionStateToRowState(s.status, s.openSlot);
  return {
    kind: 'session',
    id: s.id,
    state,
    counterpart: s.counterpart,
    yourCount: s.yourCards.reduce((n, c) => n + c.qty, 0),
    theirCount: s.theirCards.reduce((n, c) => n + c.qty, 0),
    lastActivityAt: s.lastEditedAt,
    openSlot: s.openSlot,
  };
}

function sessionStateToRowState(status: SessionStatus, openSlot: boolean): TradeRowState {
  if (status === 'active') return openSlot ? 'shared-waiting' : 'shared';
  return status;
}
