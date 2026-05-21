import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../services/apiClient';

/**
 * Mutation lifecycle primitive for fetch+mutate hooks.
 *
 * Generalises the gen-counter race-protection pattern that
 * `useGuildMemberships` and `useAccountSettings` were each hand-rolling
 * (and that audit 13-mutation-patterns flagged as bug-prone — without
 * the guard, two rapid mutations race: PUT-1's slow response lands
 * after PUT-2 and clobbers the user's latest edit).
 *
 * What's the shared shape across `useGuildMemberships.updateGuild`,
 * `useAccountSettings.update`, and (eventually) others?
 *
 *   1. Bump a generation counter to mark this call as in-flight.
 *   2. Apply an optimistic local state.
 *   3. Fire the request.
 *   4. If the gen counter has moved on (a newer call started), drop
 *      our post-await side effects — the newer call's response will
 *      land authoritative state.
 *   5. On success: optionally apply canonical state from the response.
 *   6. On failure: roll back via either an explicit rollback callback
 *      or by re-running the fetcher.
 *
 * `useSession` deliberately does NOT consume this primitive — its
 * `runMutation` adds polling + seenCounterpartEditAt + preview-state
 * concerns that don't generalise. The shared shape is the gen-counter
 * + optimistic + rollback; everything else is hook-specific.
 *
 * Cache integration is opt-in via `config.cache`. When provided, every
 * state write mirrors to the cache so sibling hook instances stay in
 * sync. Without it the resource is purely in-memory.
 */

export type ResourceStatus = 'loading' | 'ready' | 'saving' | 'error';

/**
 * One mutation against the resource. Each call is gen-counter guarded.
 *
 * - `optimistic`: apply local state immediately (current → next). Skip
 *   when there's nothing to optimistically update.
 * - `request`: the server call.
 * - `applyCanonical`: on success, derive the next local state from the
 *   server response. Skip when the optimistic state IS the canonical
 *   state (e.g. simple prefs patch where the server just confirms).
 * - `rollback`: on failure, recover. Defaults to re-running the
 *   resource's `fetcher`. Provide explicitly to skip the network
 *   round-trip (e.g. roll back to a snapshot taken before optimistic).
 */
export interface MutationConfig<T, R extends Record<string, unknown>, E extends string = never> {
  optimistic?: (current: T) => T;
  request: () => Promise<ActionResult<R, E>>;
  applyCanonical?: (current: T, response: R) => T;
  rollback?: () => Promise<T | null> | T | null;
}

export interface ResourceApi<T> {
  data: T | null;
  status: ResourceStatus;
  /** Re-run the fetcher and overwrite state. */
  refresh: () => Promise<void>;
  /** Run a server-mutating call with gen-counter race protection.
   *  Returns the raw ActionResult so callers can narrow on domain
   *  failures (decline's typed reasons, etc.). */
  runMutation: <R extends Record<string, unknown>, E extends string = never>(
    config: MutationConfig<T, R, E>,
  ) => Promise<ActionResult<R, E>>;
  /** Direct state setter — for non-mutation flows that update via a
   *  different endpoint (e.g. refresh-from-Discord). When the resource
   *  has a cache mirror, this also writes the cache. */
  setData: (next: T | ((prev: T | null) => T)) => void;
  setStatus: (next: ResourceStatus) => void;
}

export interface ResourceConfig<T> {
  /** Optional initial value (e.g. from a cache). When set, status
   *  defaults to 'ready' and the auto-mount fetch is skipped. */
  initial?: T | null;
  /** Override the inferred initial status. */
  initialStatus?: ResourceStatus;
  /**
   * Pull canonical state from the server. Returns null on failure so
   * the hook can flip to 'error' without throwing through React.
   */
  fetcher: () => Promise<T | null>;
  /**
   * Optional cache mirror. When provided, every successful state
   * write also writes the cache so sibling instances stay in sync.
   * `initial` should be the cache's current value; useResource doesn't
   * read the cache on its own — the caller decides when to seed.
   */
  cache?: {
    write: (next: T) => void;
  };
  /**
   * When set true, the auto-mount fetch fires even when `initial` is
   * provided — useful for "show cached immediately, then revalidate."
   * Defaults to false.
   */
  revalidateOnMount?: boolean;
}

export function useResource<T>(config: ResourceConfig<T>): ResourceApi<T> {
  const [data, setDataState] = useState<T | null>(config.initial ?? null);
  const [status, setStatus] = useState<ResourceStatus>(
    config.initialStatus ?? (config.initial != null ? 'ready' : 'loading'),
  );
  const dataRef = useRef<T | null>(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  // Stable refs for the caller-supplied config so the auto-mount and
  // refresh effects don't re-fire on every parent render.
  const fetcherRef = useRef(config.fetcher);
  useEffect(() => { fetcherRef.current = config.fetcher; }, [config.fetcher]);
  const cacheWriteRef = useRef(config.cache?.write);
  useEffect(() => { cacheWriteRef.current = config.cache?.write; }, [config.cache?.write]);

  // Per-call generation counter. Bumped on each runMutation entry;
  // post-await branches check `gen !== latest` to drop their side
  // effects when a newer call has superseded them.
  const genRef = useRef(0);

  const setData = useCallback((next: T | ((prev: T | null) => T)) => {
    setDataState(prev => {
      const resolved = typeof next === 'function'
        ? (next as (p: T | null) => T)(prev)
        : next;
      cacheWriteRef.current?.(resolved);
      return resolved;
    });
  }, []);

  const refresh = useCallback(async () => {
    const result = await fetcherRef.current();
    if (result === null) {
      setStatus('error');
      return;
    }
    setData(result);
    setStatus('ready');
  }, [setData]);

  // Auto-mount fetch. Skipped when initial data was provided unless
  // revalidateOnMount opts in. Runs once per hook instance.
  const initialProvided = config.initial != null;
  const revalidateOnMount = config.revalidateOnMount ?? false;
  useEffect(() => {
    if (initialProvided && !revalidateOnMount) return;
    refresh();
    // refresh is stable; intentional one-shot on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runMutation = useCallback(async function run<R extends Record<string, unknown>, E extends string = never>(
    mutConfig: MutationConfig<T, R, E>,
  ): Promise<ActionResult<R, E>> {
    const gen = ++genRef.current;

    if (mutConfig.optimistic && dataRef.current != null) {
      const next = mutConfig.optimistic(dataRef.current);
      setData(next);
    }
    setStatus('saving');

    const result = await mutConfig.request();

    // Stale-response guard: a newer mutation has started since we
    // claimed our gen. Drop our post-await side effects — the newer
    // call's optimistic state is the truth and its response will
    // carry forward.
    if (gen !== genRef.current) return result;

    if (!result.ok) {
      if (mutConfig.rollback) {
        const next = await mutConfig.rollback();
        if (gen !== genRef.current) return result;
        if (next != null) setData(next);
      } else {
        const fresh = await fetcherRef.current();
        if (gen !== genRef.current) return result;
        if (fresh != null) setData(fresh);
      }
      setStatus('error');
      return result;
    }

    if (mutConfig.applyCanonical && dataRef.current != null) {
      setData(mutConfig.applyCanonical(dataRef.current, result.data));
    }
    setStatus('ready');
    return result;
  }, [setData]);

  return { data, status, refresh, runMutation, setData, setStatus };
}
