import { useEffect, useRef, useState, useCallback } from 'react';
import { apiGet, apiPut } from '../services/apiClient';
import type { User } from './useAuth';
import { normalizeRestriction, type WantsApi } from './useWants';
import type { AvailableApi } from './useAvailable';
import type { WantsItem, AvailableItem } from '../persistence/schemas';

/**
 * Sync-list-bundle hook (filename retained as `useServerSync` for
 * import stability; the conceptual model is a *bundle*).
 *
 * One hook owns:
 *   - **Initial sync** on sign-in (push-up on first-ever sign-in with
 *     local items + empty server; otherwise server-wins overwrite).
 *   - **Foreground re-pull** across visibilitychange / focus / a 60s
 *     visible-tab safety poll — captures the multi-device case.
 *   - **Debounced PUT** on local mutations.
 *   - **Gen-counter writeback contract** that makes it safe for the
 *     bundle to call `slot.setAll(server)` without echoing it back
 *     as a spurious PUT.
 *
 * Each *slot* in the bundle is a list-like persisted resource — today
 * `wants` and `available`. Adding a third slot (favourites, signal
 * drafts, etc.) is a config entry, not new orchestration code. The
 * shape:
 *
 *   { items: T[]; setAll: (next: T[]) => void;
 *     getUrl: string; putUrl: string; normalize?: (item: T) => T }
 *
 * The contract on `setAll`: it is the bundle's writeback channel and
 * should not be called from outside this module. (Today the
 * convention is enforced by the fact that the only `.setAll` call
 * sites in the codebase live here. The named `SyncSlot` interface
 * documents the role at the type-system level.)
 *
 * Why one hook over two: wants + available sync as a unit. Initial
 * push-up and foreground re-pull touch both endpoints in lockstep;
 * the gen counter is shared across them. Splitting would force the
 * coordination back into a parent.
 */

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

/**
 * One participant in the bundle. The bundle treats every slot
 * uniformly: pull from `getUrl`, push to `putUrl`, apply `normalize`
 * on inbound items, write back via `setAll`.
 */
interface SyncSlot<T> {
  items: T[];
  setAll: (next: T[]) => void;
  getUrl: string;
  putUrl: string;
  /** Optional inbound transform — e.g. collapse stale variant
   *  restrictions on `wants`. */
  normalize?: (items: T[]) => T[];
}

export interface ServerSyncApi {
  status: SyncStatus;
}

/**
 * Sync-list bundle. Public-API-stable wrapper around the slot-based
 * implementation: takes `wants` + `available` + `user` and returns a
 * sync-status hook. Internally builds two `SyncSlot`s and runs them
 * through `useSyncedListBundleImpl`.
 */
export function useServerSync(
  wants: WantsApi,
  available: AvailableApi,
  user: User | null,
): ServerSyncApi {
  return useSyncedListBundleImpl(
    {
      wants: {
        items: wants.items,
        setAll: wants.setAll,
        getUrl: '/api/sync/wants',
        putUrl: '/api/sync/wants',
        normalize: normalizeServerWants,
      } satisfies SyncSlot<WantsItem>,
      available: {
        items: available.items,
        setAll: available.setAll,
        getUrl: '/api/sync/available',
        putUrl: '/api/sync/available',
      } satisfies SyncSlot<AvailableItem>,
    },
    user,
  );
}

/**
 * The generalised bundle implementation. Operates over a record of
 * slots — wants/available today; favourites/etc. tomorrow.
 *
 * Holds the writeback gen-counter pair (`serverWriteGenRef` /
 * `lastSeenWriteGenRef`) that lets the items-changed effect tell
 * "server wrote this" from "user edited this". Without the counter,
 * a server writeback would trigger the items effect, which would
 * schedule a debounced PUT 500ms later, echoing the value back —
 * the symptom that motivated this contract.
 */
// `any` here is the necessary type-erasure point — each slot's own T
// is fully type-checked at the construction site (see useServerSync).
// The impl operates uniformly over them and can't see the per-slot
// shape; trying to keep `unknown` would force unsafe casts at every
// `setAll` callsite. Centralising the erasure here keeps the impl
// readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useSyncedListBundleImpl<TSlots extends Record<string, SyncSlot<any>>>(
  slots: TSlots,
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

  /**
   * Apply a server response across the bundle. Increments the
   * gen-counter first so the items-effect can detect this as a
   * writeback (no echo PUT). Each slot's optional `normalize` runs
   * before its `setAll`.
   */
  const applyServerResponses = useCallback(
    (responses: Record<keyof TSlots, unknown[]>) => {
      serverWriteGenRef.current += 1;
      for (const key in slots) {
        const slot = slots[key];
        const items = responses[key];
        const normalized = slot.normalize
          ? slot.normalize(items as never)
          : (items as never);
        // setAll's type per slot is set by the parameterised type; the
        // erasure here is safe because the slot's normalize (or
        // identity) returned the slot's own T[].
        (slot.setAll as (next: unknown[]) => void)(normalized);
      }
    },
    [slots],
  );

  /**
   * Push every slot's local items to its `putUrl` in parallel.
   * Settles `status` based on the worst outcome.
   */
  const pushAll = useCallback(async () => {
    await Promise.all(
      Object.values(slots).map(slot => syncPut(slot.putUrl, slot.items)),
    );
  }, [slots]);

  /**
   * Pull every slot in parallel. Returns a record keyed by slot name.
   */
  const pullAll = useCallback(async (): Promise<Record<keyof TSlots, unknown[]>> => {
    const entries = await Promise.all(
      Object.entries(slots).map(async ([key, slot]) => {
        const items = await syncGet<unknown[]>(slot.getUrl);
        return [key, items] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<keyof TSlots, unknown[]>;
  }, [slots]);

  // Initial sync on sign-in or mount. Server is always the source of
  // truth — local data only ever migrates upward when the server is
  // genuinely empty (first-ever sign-in for this Discord account).
  // If the server has anything, we apply it directly and overwrite
  // the device's local cache.
  useEffect(() => {
    if (!user) {
      prevUserRef.current = null;
      initialSyncDoneRef.current = false;
      return;
    }

    const wasSignedOut = prevUserRef.current === null;
    prevUserRef.current = user;

    const hasLocalItems = Object.values(slots).some(s => s.items.length > 0);

    (async () => {
      setStatus('syncing');
      try {
        const pulled = await pullAll();
        const serverHasData = Object.values(pulled).some(arr => arr.length > 0);

        if (wasSignedOut && hasLocalItems && !serverHasData) {
          // First-ever sign-in with local items to bring along.
          // Push silently — the server is empty so there's nothing
          // to lose. Round-trip via a fresh pull so the device sees
          // any normalisation the server did on insert.
          await pushAll();
          const repulled = await pullAll();
          applyServerResponses(repulled);
        } else {
          // Server-wins for every other case (multi-device, repeat
          // sign-in).
          applyServerResponses(pulled);
        }
        initialSyncDoneRef.current = true;
        setStatus('idle');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        setStatus(msg === 'auth-expired' ? 'error' : 'offline');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Re-pull on tab/app foreground so a phone signed in hours ago picks
  // up edits made on another device. Without this, initial sign-in is
  // the only refresh — a long-idle session reads stale localStorage
  // until reload. Three triggers, each catching a case the others miss:
  // visibilitychange, window.focus (Safari quirk + alt-tab), and a
  // 60s visible-tab poll for the always-foregrounded case.
  useEffect(() => {
    if (!user) return;

    const pull = async () => {
      if (!initialSyncDoneRef.current) return;
      // Debounced PUT pending → skip; pulling first would clobber the
      // local edits about to push.
      if (debounceRef.current) return;
      setStatus('syncing');
      try {
        const pulled = await pullAll();
        applyServerResponses(pulled);
        setStatus('idle');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        setStatus(msg === 'auth-expired' ? 'error' : 'offline');
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') pull();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', pull);
    const pollInterval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      pull();
    }, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', pull);
      window.clearInterval(pollInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Debounced sync on local mutations — only after initial sync.
  // Watches every slot's `items` reference. The gen-counter check
  // skips when this items change came from a server writeback
  // (initial sync, foreground re-pull, etc.) instead of a real
  // local edit.
  //
  // We can't list slot.items individually in the dep array (the
  // record is generic) so we synthesise a stable key from the
  // array references. React's bailout still works because writing
  // the same array reference twice is rare.
  const itemsKey = Object.values(slots).map(s => s.items);
  useEffect(() => {
    if (!user || !initialSyncDoneRef.current) return;

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
        await pushAll();
        setStatus('idle');
      } catch {
        setStatus('error');
      }
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...itemsKey, user?.id]);

  return { status };
}
