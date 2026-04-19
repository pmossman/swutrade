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
