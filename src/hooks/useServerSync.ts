import { useEffect, useRef, useState, useCallback } from 'react';
import { apiGet, apiPut } from '../services/apiClient';
import type { User } from './useAuth';
import type { WantsApi } from './useWants';
import type { AvailableApi } from './useAvailable';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

export interface MigrationPrompt {
  wantsCount: number;
  availableCount: number;
  onImport: () => void;
  onSkip: () => void;
}

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
  /** Non-null when the user just signed in for the first time and
   *  has local items to migrate. The sync hook pauses until the user
   *  chooses Import or Start Fresh. */
  migrationPrompt: MigrationPrompt | null;
}

export function useServerSync(
  wants: WantsApi,
  available: AvailableApi,
  user: User | null,
): ServerSyncApi {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [migrationPrompt, setMigrationPrompt] = useState<MigrationPrompt | null>(null);
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

  const pullAndApply = useCallback(async () => {
    const [serverWants, serverAvailable] = await Promise.all([
      syncGet<typeof wants.items>('/api/sync/wants'),
      syncGet<typeof available.items>('/api/sync/available'),
    ]);
    writingBackRef.current = true;
    wants.setAll(serverWants);
    available.setAll(serverAvailable);
    writingBackRef.current = false;
  }, [wants, available]);

  const doImport = useCallback(async () => {
    setMigrationPrompt(null);
    setStatus('syncing');
    try {
      await Promise.all([
        pushWants(wants.items),
        pushAvailable(available.items),
      ]);
      await pullAndApply();
      initialSyncDoneRef.current = true;
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }, [wants.items, available.items, pushWants, pushAvailable, pullAndApply]);

  const doSkip = useCallback(async () => {
    setMigrationPrompt(null);
    setStatus('syncing');
    try {
      // Don't push local items — just pull whatever's on the server
      // (empty for first-time users).
      await pullAndApply();
      initialSyncDoneRef.current = true;
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }, [pullAndApply]);

  // Initial sync on sign-in or mount.
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
        // Check if the server already has data (returning user on
        // new device, or second sign-in). If so, skip the migration
        // prompt — just pull.
        const [serverWants, serverAvailable] = await Promise.all([
          syncGet<unknown[]>('/api/sync/wants'),
          syncGet<unknown[]>('/api/sync/available'),
        ]);
        const serverHasData = serverWants.length > 0 || serverAvailable.length > 0;

        if (wasSignedOut && hasLocalItems && !serverHasData) {
          // First sign-in with local items + empty server → prompt.
          setStatus('idle');
          setMigrationPrompt({
            wantsCount: localWantsCount,
            availableCount: localAvailableCount,
            onImport: doImport,
            onSkip: doSkip,
          });
          return;
        }

        // No migration needed — if server has data, pull it. If
        // returning user with local items, server wins (LWW).
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

  return { status, migrationPrompt };
}
