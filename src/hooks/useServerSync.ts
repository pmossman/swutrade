import { useEffect, useRef, useState, useCallback } from 'react';
import { apiGet, apiPut } from '../services/apiClient';
import type { User } from './useAuth';
import type { WantsApi } from './useWants';
import type { AvailableApi } from './useAvailable';

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
  const writingBackRef = useRef(false);
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
          writingBackRef.current = true;
          wants.setAll(w as typeof wants.items);
          available.setAll(a as typeof available.items);
          writingBackRef.current = false;
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
        writingBackRef.current = true;
        wants.setAll(serverWants as typeof wants.items);
        available.setAll(serverAvailable as typeof available.items);
        writingBackRef.current = false;
        initialSyncDoneRef.current = true;
        setStatus('idle');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        setStatus(msg === 'auth-expired' ? 'error' : 'offline');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Debounced sync on local mutations — only after initial sync.
  useEffect(() => {
    if (!user || writingBackRef.current || !initialSyncDoneRef.current) return;

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
