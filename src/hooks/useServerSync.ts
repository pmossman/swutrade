import { useEffect, useRef, useState, useCallback } from 'react';
import type { User } from './useAuth';
import type { WantsApi } from './useWants';
import type { AvailableApi } from './useAvailable';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  });
  if (res.status === 401) throw new Error('auth-expired');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/**
 * Bidirectional sync between localStorage (via useWants/useAvailable)
 * and the server (via /api/sync/*). Activated only when the user is
 * signed in — anonymous users never hit the server.
 *
 * Strategy:
 *   - On sign-in (user transitions null → non-null): push local
 *     lists to server (migration), then write server canonical
 *     state back to local.
 *   - On mount when already signed in: fetch server state, write
 *     to local.
 *   - On every local mutation: debounced PUT to server (500ms).
 *
 * The server always returns the canonical state after a PUT, so
 * the local lists stay in sync even if another device pushed
 * changes between our reads.
 */
export function useServerSync(
  wants: WantsApi,
  available: AvailableApi,
  user: User | null,
): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const prevUserRef = useRef<User | null>(null);
  const syncVersionRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Suppress sync-back writes triggered by setAll (avoids loops).
  const writingBackRef = useRef(false);

  const pushWants = useCallback(async (items: typeof wants.items) => {
    return fetchJson<typeof wants.items>('/api/sync/wants', {
      method: 'PUT',
      body: JSON.stringify(items),
    });
  }, []);

  const pushAvailable = useCallback(async (items: typeof available.items) => {
    return fetchJson<typeof available.items>('/api/sync/available', {
      method: 'PUT',
      body: JSON.stringify(items),
    });
  }, []);

  const pullAndApply = useCallback(async () => {
    const [serverWants, serverAvailable] = await Promise.all([
      fetchJson<typeof wants.items>('/api/sync/wants'),
      fetchJson<typeof available.items>('/api/sync/available'),
    ]);
    writingBackRef.current = true;
    wants.setAll(serverWants);
    available.setAll(serverAvailable);
    writingBackRef.current = false;
  }, [wants, available]);

  // Initial sync: on sign-in or on mount when already signed in.
  useEffect(() => {
    if (!user) {
      prevUserRef.current = null;
      return;
    }

    const wasSignedOut = prevUserRef.current === null;
    prevUserRef.current = user;

    (async () => {
      setStatus('syncing');
      try {
        if (wasSignedOut && (wants.items.length > 0 || available.items.length > 0)) {
          // Migration: push local lists to server first.
          await Promise.all([
            pushWants(wants.items),
            pushAvailable(available.items),
          ]);
        }
        await pullAndApply();
        setStatus('idle');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        setStatus(msg === 'auth-expired' ? 'error' : 'offline');
      }
    })();
    // Only run when user identity changes, not on every items change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Debounced sync on local mutations.
  useEffect(() => {
    if (!user || writingBackRef.current) return;

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

  return status;
}
