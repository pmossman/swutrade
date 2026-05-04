import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../services/apiClient';
import { createSingletonCache } from './sharedCache';
import type { SessionView } from './useSession';

/**
 * Compact view of an active shared trade session, sized for the
 * Trades page's Shared tab. Pulls the heavy SessionView wire shape
 * from `/api/me/sessions` and projects it down to what the row
 * needs (counterpart identity, card counts, freshness, open-slot
 * marker). Heavier session detail (timeline events, suggestions,
 * unread counts) lives in `useSession` for the canvas itself.
 */
export interface ActiveSessionEntry {
  /** Session short-code; opens `/s/<id>`. */
  id: string;
  counterpart: { handle: string; username: string; avatarUrl: string | null } | null;
  yourCount: number;
  theirCount: number;
  /** ISO timestamp — newest-first sort key for the list. */
  lastEditedAt: string;
  /** True when slot B is still open (creator waiting on a QR scan).
   *  UI calls this out separately so the user knows there's no
   *  counterpart yet. */
  openSlot: boolean;
}

export interface ActiveSessionsApi {
  sessions: ActiveSessionEntry[];
  status: 'loading' | 'ready' | 'error';
  /** Force a fresh fetch — e.g., after returning to the Trades page
   *  from a session canvas where edits may have happened. */
  refresh: () => Promise<void>;
}

interface CachedShape {
  sessions: ActiveSessionEntry[];
}

// Module-scoped singleton cache: same stale-while-revalidate pattern
// as useTradesList / useGuildMemberships. First mount fetches fresh;
// subsequent mounts in the same SPA session render cached data
// immediately and refresh in the background.
const cache = createSingletonCache<CachedShape>();

/** Testing-only: reset the module-scoped cache between cases. */
export function __resetActiveSessionsCache() {
  cache.clear();
}

export function useActiveSessions(): ActiveSessionsApi {
  const [sessions, setSessions] = useState<ActiveSessionEntry[]>(
    () => cache.get()?.sessions ?? [],
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    () => (cache.has() ? 'ready' : 'loading'),
  );

  const fetchOnce = useCallback(async () => {
    const result = await apiGet<{ sessions: SessionView[] }>('/api/me/sessions');
    if (!result.ok) {
      // If we have cached data, keep showing it rather than flipping
      // to error — the user already saw something real. Same shape
      // useTradesList uses.
      if (!cache.has()) setStatus('error');
      return;
    }
    const projected = result.data.sessions.map(toEntry);
    // Newest-first by last-edit. The server returns by recency too,
    // but doing this here keeps the contract explicit and survives
    // future API changes.
    projected.sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt));
    cache.set({ sessions: projected });
    setSessions(projected);
    setStatus('ready');
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await fetchOnce();
    })();
    return () => { cancelled = true; };
  }, [fetchOnce]);

  return { sessions, status, refresh: fetchOnce };
}

function toEntry(s: SessionView): ActiveSessionEntry {
  return {
    id: s.id,
    counterpart: s.counterpart
      ? {
          handle: s.counterpart.handle,
          username: s.counterpart.username,
          avatarUrl: s.counterpart.avatarUrl,
        }
      : null,
    yourCount: s.yourCards.reduce((n, c) => n + c.qty, 0),
    theirCount: s.theirCards.reduce((n, c) => n + c.qty, 0),
    lastEditedAt: s.lastEditedAt,
    openSlot: s.openSlot,
  };
}
