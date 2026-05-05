import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet } from '../services/apiClient';
import { createSingletonCache } from './sharedCache';
import type { SessionView, SessionStatus } from './useSession';

/**
 * Client-side view layer for the Home "My Trades" module. Sessions
 * are the only trade primitive after Phase C — proposals were retired
 * because every flow they supported is now a strict subset of session
 * capabilities (B1-B7 brought sessions to no-gap-vs-proposals).
 *
 * Each TradeRow renders the same way in a list: counterpart
 * identity, state badge, card counts, last activity. `kind` is kept
 * for forward-compat (a future trade primitive could plug in here)
 * but currently always 'session'.
 */
export type TradeRowState =
  /** Session with both slots filled, still active. */
  | 'shared'
  /** Session with slot B open — creator waiting on a QR scan. */
  | 'shared-waiting'
  /** Session settled (both confirmed). */
  | 'settled'
  /** Session cancelled — either mutually withdrawn (`cancel_reason='withdrawn'`)
   *  or declined by the recipient (`cancel_reason='declined'`). The
   *  per-row chrome doesn't distinguish; the SessionView terminal
   *  banner handles that copy. */
  | 'cancelled'
  | 'expired';

export interface TradeRowCounterpart {
  userId: string;
  handle: string;
  username: string;
  avatarUrl: string | null;
  isAnonymous?: boolean;
}

export interface TradeRow {
  kind: 'session';
  /** Session short-code. */
  id: string;
  state: TradeRowState;
  counterpart: TradeRowCounterpart | null;
  yourCount: number;
  theirCount: number;
  /** ISO timestamp — sort key for the unified list. */
  lastActivityAt: string;
  /** True when slot B is still open (QR-only sharing, no claim yet). */
  openSlot?: boolean;
  /** B6 — true when the session is waiting on the viewer
   *  (counterpart confirmed and viewer hasn't, or there's an
   *  unresolved suggestion targeting the viewer). Drives Inbox row
   *  prominence on Home. */
  awaitingViewer?: boolean;
}

export interface MyTradesApi {
  rows: TradeRow[];
  /** Sessions waiting on the viewer's response. The Home callout +
   *  Inbox highlight read this directly. */
  needsResponse: TradeRow[];
  /** Counts used by activity summaries. Derived purely from the
   *  rows array. */
  counts: { activeSessions: number; resolved: number };
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
    const result = await apiGet<{ sessions: SessionView[] }>('/api/me/sessions');
    if (!result.ok) {
      if (!cache.has()) setStatus('error');
      return;
    }
    const merged = result.data.sessions
      .map(sessionToRow)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    cache.set({ rows: merged });
    setRows(merged);
    setStatus('ready');
  }, []);

  useEffect(() => {
    fetchOnce();
  }, [fetchOnce]);

  // "Needs response" → sessions where the server's awaitingViewer
  // flag is set. B6 derives this from confirm-state + suggestion
  // targeting; this hook is just the read-through.
  const needsResponse = useMemo(
    () => rows.filter(r => r.awaitingViewer === true),
    [rows],
  );

  const counts = useMemo(() => {
    let activeSessions = 0;
    let resolved = 0;
    for (const r of rows) {
      if (r.state === 'shared' || r.state === 'shared-waiting') activeSessions += 1;
      else resolved += 1;
    }
    return { activeSessions, resolved };
  }, [rows]);

  return { rows, needsResponse, counts, status, refresh: fetchOnce };
}

// --- normalizers ----------------------------------------------------------

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
    awaitingViewer: s.awaitingViewer,
  };
}

function sessionStateToRowState(status: SessionStatus, openSlot: boolean): TradeRowState {
  if (status === 'active') return openSlot ? 'shared-waiting' : 'shared';
  return status;
}
