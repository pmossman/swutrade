import { useEffect, useRef, useState, useCallback } from 'react';
import { apiGet, apiPut } from '../services/apiClient';
import type { User } from './useAuth';
import { normalizeRestriction, type WantsApi } from './useWants';
import type { AvailableApi } from './useAvailable';

/**
 * Apply `normalizeRestriction` to every server-pulled wants row so a
 * pre-fix client (or any future bug that wrote a 10-variant
 * restriction) is collapsed back to `{ mode: 'any' }` on this
 * device's hydration. Without this, DB-resident bad data would
 * propagate back on every PUT.
 */
function normalizeServerWants<T extends { restriction: Parameters<typeof normalizeRestriction>[0] }>(
  items: readonly T[],
): T[] {
  return items.map(item => ({
    ...item,
    restriction: normalizeRestriction(item.restriction),
  }));
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

// Wraps apiGet/apiPut with the legacy 'auth-expired' sentinel so the
// surrounding control flow (which distinguishes a real 401 from a
// generic network blip) keeps working. Once Phase 4 lands a context-
// layer auth-lifecycle, this can be collapsed into plain discriminated
// handling at each call site.
async function syncGet<T>(url: string): Promise<T> {
  const result = await apiGet<T>(url);
  if (result.ok) return result.data;
  if (result.reason === 'unauthorized') throw new Error('auth-expired');
  throw new Error(result.reason);
}

async function syncPut<T>(url: string, body: unknown): Promise<T> {
  const result = await apiPut<T>(url, body);
  if (result.ok) return result.data;
  if (result.reason === 'unauthorized') throw new Error('auth-expired');
  throw new Error(result.reason);
}

export interface ServerSyncApi {
  status: SyncStatus;
}

export function useServerSync(
  wants: WantsApi,
  available: AvailableApi,
  user: User | null,
): ServerSyncApi {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const prevUserRef = useRef<User | null>(null);
  const syncVersionRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Server-write generation counter. Each writeback increments it
  // BEFORE the setAll calls; the items-changed effect compares
  // against the value it last observed and skips scheduling a
  // debounced PUT when a writeback caused the change. Replaces the
  // earlier `writingBackRef` flag, which was synchronously cleared
  // around `setAll(...)` — by the time React fired the items effect,
  // the flag had already flipped to false and the debounce ran a
  // spurious round-trip 500ms later. Audit 06-lists #1; same
  // gen-counter pattern as Sprint 1's saveCards-shape race fixes.
  const serverWriteGenRef = useRef(0);
  const lastSeenWriteGenRef = useRef(0);
  // Once initial sync completes, debounced mutations are allowed.
  const initialSyncDoneRef = useRef(false);

  const pushWants = useCallback(async (items: typeof wants.items) => {
    return syncPut<typeof wants.items>('/api/sync/wants', items);
  }, []);

  const pushAvailable = useCallback(async (items: typeof available.items) => {
    return syncPut<typeof available.items>('/api/sync/available', items);
  }, []);

  // Initial sync on sign-in or mount. Server is always the source
  // of truth — local data only ever migrates upward when the server
  // is genuinely empty (first-ever sign-in for this Discord account).
  // If the server has anything, we apply it directly and overwrite
  // the device's local cache. No "Import or Start Fresh?" prompt
  // anymore — that step routinely confused users into dismissing
  // away their own server data, leaving the device showing stale
  // localStorage that never re-synced.
  useEffect(() => {
    if (!user) {
      prevUserRef.current = null;
      initialSyncDoneRef.current = false;
      return;
    }

    const wasSignedOut = prevUserRef.current === null;
    prevUserRef.current = user;

    const localWantsCount = wants.items.length;
    const localAvailableCount = available.items.length;
    const hasLocalItems = localWantsCount > 0 || localAvailableCount > 0;

    (async () => {
      setStatus('syncing');
      try {
        const [serverWants, serverAvailable] = await Promise.all([
          syncGet<unknown[]>('/api/sync/wants'),
          syncGet<unknown[]>('/api/sync/available'),
        ]);
        const serverHasData = serverWants.length > 0 || serverAvailable.length > 0;

        if (wasSignedOut && hasLocalItems && !serverHasData) {
          // First-ever sign-in for this Discord account with local
          // items to bring along. Push them up silently — the
          // server is empty so there's nothing to lose, and the
          // user shouldn't have to think about it.
          await Promise.all([
            pushWants(wants.items),
            pushAvailable(available.items),
          ]);
          // Round-trip via a fresh pull so the device's items now
          // reflect any normalisation the server did on insert.
          const [w, a] = await Promise.all([
            syncGet<unknown[]>('/api/sync/wants'),
            syncGet<unknown[]>('/api/sync/available'),
          ]);
          serverWriteGenRef.current += 1;
          wants.setAll(normalizeServerWants(w as typeof wants.items));
          available.setAll(a as typeof available.items);
          initialSyncDoneRef.current = true;
          setStatus('idle');
          return;
        }

        // Server-wins: any time the server has data, apply it. This
        // covers the multi-device case (signed in elsewhere first)
        // + the same-device-second-sign-in case. Local items on
        // this device get overwritten — that's the right behavior
        // because the user's seen-state across devices is the
        // server view.
        serverWriteGenRef.current += 1;
        wants.setAll(normalizeServerWants(serverWants as typeof wants.items));
        available.setAll(serverAvailable as typeof available.items);
        initialSyncDoneRef.current = true;
        setStatus('idle');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        setStatus(msg === 'auth-expired' ? 'error' : 'offline');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Re-pull on tab/app foreground so a phone that was signed in
  // hours ago picks up edits made on another device. Without this,
  // the initial sign-in pull is the only refresh — a long-idle
  // session reads stale localStorage forever (until reload).
  //
  // Skip rules:
  //   - signed out → nothing to pull
  //   - initial sync hasn't completed → the mount effect will handle it
  //   - debounce timer is pending → local edits about to push; pulling
  //     first would clobber them. Wait for the next foreground event
  //     after the push has settled.
  useEffect(() => {
    if (!user) return;

    const pull = async () => {
      if (!initialSyncDoneRef.current) return;
      if (debounceRef.current) return;
      setStatus('syncing');
      try {
        const [serverWants, serverAvailable] = await Promise.all([
          syncGet<unknown[]>('/api/sync/wants'),
          syncGet<unknown[]>('/api/sync/available'),
        ]);
        serverWriteGenRef.current += 1;
        wants.setAll(normalizeServerWants(serverWants as typeof wants.items));
        available.setAll(serverAvailable as typeof available.items);
        setStatus('idle');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        setStatus(msg === 'auth-expired' ? 'error' : 'offline');
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') pull();
    };
    // Both events: visibilitychange covers tab-switching and most
    // mobile foreground/background transitions; window.focus is the
    // belt-and-suspenders for Safari quirks where vischange doesn't
    // always fire on app resume.
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', pull);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', pull);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Debounced sync on local mutations — only after initial sync.
  useEffect(() => {
    if (!user || !initialSyncDoneRef.current) return;

    // Skip when this items change came from a server writeback
    // (initial sync, foreground re-pull, etc.) instead of a real
    // local edit. The writeback path increments
    // `serverWriteGenRef`; comparing against the gen we last saw
    // tells us whether the items effect was triggered by us flipping
    // the writeback gen, in which case there's no user edit to push.
    if (serverWriteGenRef.current !== lastSeenWriteGenRef.current) {
      lastSeenWriteGenRef.current = serverWriteGenRef.current;
      return;
    }

    syncVersionRef.current += 1;
    const version = syncVersionRef.current;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (syncVersionRef.current !== version) return;
      setStatus('syncing');
      try {
        await Promise.all([
          pushWants(wants.items),
          pushAvailable(available.items),
        ]);
        setStatus('idle');
      } catch {
        setStatus('error');
      }
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wants.items, available.items, user?.id]);

  return { status };
}
