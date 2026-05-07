/**
 * Small module-scoped cache primitives used by the client data hooks
 * (useTradesList, useTradeDetail, useGuildMemberships). Previously each
 * hook hand-rolled its own `let cached…` sentinel + `__reset*Cache()`
 * escape hatch, with subtle differences (some tracked a `has` flag,
 * some relied on the value being null-vs-object, some used a Map).
 *
 * One typed primitive each, one get/set/clear/has contract:
 *   - `createSingletonCache<V>()` — one entry, no key (list/summary
 *     responses that aren't keyed by anything but the viewer).
 *   - `createKeyedCache<K, V>()`  — map-backed, for per-id responses
 *     like a single proposal's detail.
 *
 * Both stay module-scoped at the call site (`const cache = createX()`
 * at the top of the hook file). The primitives are deliberately
 * minimal — state management (seed-from-cache-on-mount, invalidate on
 * mutation, stale-while-revalidate) lives in each hook, because the
 * lifecycle details differ (e.g. auth transitions should wipe the list
 * cache but preserve the detail cache).
 *
 * Testing: `clear()` replaces the old `__reset*Cache()` exports. Test
 * files import the hook's cache directly via the re-export the hook
 * provides or via an explicit reset helper; either is one line.
 */

export interface SingletonCache<V> {
  get(): V | undefined;
  set(v: V): void;
  clear(): void;
  has(): boolean;
}

export function createSingletonCache<V>(): SingletonCache<V> {
  // Use a separate `has` flag so callers can distinguish "unset" from
  // "set to undefined". Matters when V can include nullable fields.
  let value: V | undefined;
  let present = false;
  return {
    get: () => value,
    set: v => {
      value = v;
      present = true;
    },
    clear: () => {
      value = undefined;
      present = false;
    },
    has: () => present,
  };
}

export interface PersistentCacheOptions<V> {
  /**
   * Optional shape validator. Called when hydrating from localStorage
   * — if it returns null the cached value is treated as missing
   * (cache acts as if empty + the stale entry is wiped). Use this to
   * gate against shape drift across app versions: bump the cache key
   * for a hard reset, or use a zod schema's `safeParse` for soft
   * tolerance. */
  validate?: (raw: unknown) => V | null;
  /** Override the storage backend. Defaults to `localStorage`. Tests
   *  pass a fake. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

// Registry of every persistent cache instance. `clearAllPersistent
// Caches()` walks this on logout so user A's cached rows don't flash
// for user B on the same browser. WeakSet would be wrong here — we
// genuinely want to keep references for the lifetime of the module.
const persistentCacheRegistry = new Set<{ clear: () => void }>();

/**
 * Wipe every persistent singleton cache that was created in this
 * module load. Called from useAuth.logout — by the time logout
 * resolves, no Home module should be reading the previous user's
 * data.
 *
 * NOT called automatically on auth-me-resolves-to-null on cold load:
 * that path keeps the cached rows on screen during the auth round-
 * trip and only wipes if the validator rejects the shape (different
 * app version) or the user actively logged out previously. The
 * trade-off is documented in the hook's data-flow section.
 */
export function clearAllPersistentCaches(): void {
  for (const cache of persistentCacheRegistry) cache.clear();
}

/**
 * Same shape as `createSingletonCache`, but persists through
 * localStorage so a returning user sees the same content on the next
 * cold load instead of waiting for the fetch to repaint.
 *
 * Used by hooks that feed Home modules where the pop-in is a real
 * UX papercut (`useMyTrades`, `useFavorites`, `useGuildMemberships`).
 *
 * Semantics:
 *   - `get()` returns the in-memory value if set; otherwise hydrates
 *     from localStorage on first call (only once — subsequent calls
 *     hit the in-memory copy or return undefined).
 *   - `set(v)` writes through to localStorage.
 *   - `clear()` wipes both layers — used on logout.
 *   - `has()` is true once either layer has produced a value.
 *
 * Storage failures (private-mode Safari, quota exceeded, malformed
 * JSON, validator rejection) are swallowed — the cache degrades to
 * the in-memory variant rather than throwing.
 *
 * Every persistent cache auto-registers itself for the global
 * `clearAllPersistentCaches()` sweep used on logout.
 */
export function createPersistentSingletonCache<V>(
  key: string,
  opts: PersistentCacheOptions<V> = {},
): SingletonCache<V> {
  const storage: PersistentCacheOptions<V>['storage'] | null = (() => {
    if (opts.storage) return opts.storage;
    try {
      // Touch localStorage; SSR / private-mode throw or return null.
      if (typeof localStorage === 'undefined') return null;
      return localStorage;
    } catch {
      return null;
    }
  })();

  let value: V | undefined;
  let present = false;
  let hydrated = false;

  function tryHydrate(): void {
    hydrated = true;
    if (!storage) return;
    try {
      const raw = storage.getItem(key);
      if (raw == null) return;
      const parsed = JSON.parse(raw) as unknown;
      const accepted = opts.validate ? opts.validate(parsed) : (parsed as V);
      if (accepted == null) {
        // Validator rejected → wipe so we don't keep re-reading bad
        // data + the next set() writes a clean entry.
        storage.removeItem(key);
        return;
      }
      value = accepted;
      present = true;
    } catch {
      // Malformed JSON / storage error — best-effort wipe so we
      // don't keep re-trying.
      try { storage.removeItem(key); } catch { /* ignore */ }
    }
  }

  function tryPersist(v: V): void {
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify(v));
    } catch {
      /* Quota / serialization error — fall through; in-memory layer
       * still holds the value, so the page works for this session. */
    }
  }

  function tryEvict(): void {
    if (!storage) return;
    try { storage.removeItem(key); } catch { /* ignore */ }
  }

  const cache: SingletonCache<V> = {
    get: () => {
      if (!hydrated) tryHydrate();
      return value;
    },
    set: v => {
      if (!hydrated) hydrated = true; // skip the hydrate read; we're writing.
      value = v;
      present = true;
      tryPersist(v);
    },
    clear: () => {
      hydrated = true;
      value = undefined;
      present = false;
      tryEvict();
    },
    has: () => {
      if (!hydrated) tryHydrate();
      return present;
    },
  };
  persistentCacheRegistry.add(cache);
  return cache;
}

export interface KeyedCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, v: V): void;
  delete(key: K): void;
  clear(): void;
  has(key: K): boolean;
}

export function createKeyedCache<K, V>(): KeyedCache<K, V> {
  const map = new Map<K, V>();
  return {
    get: k => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
    delete: k => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    has: k => map.has(k),
  };
}
