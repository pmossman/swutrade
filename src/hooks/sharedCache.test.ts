import { describe, it, expect } from 'vitest';
import { clearAllPersistentCaches, createPersistentSingletonCache } from './sharedCache';

/**
 * Hydration + write-through coverage for the persistent variant.
 * The non-persistent createSingletonCache is a 4-line in-memory
 * struct; not worth its own test surface.
 */

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    _peek: () => Object.fromEntries(map),
  };
}

describe('createPersistentSingletonCache', () => {
  it('returns undefined / has=false when storage has no entry', () => {
    const storage = fakeStorage();
    const cache = createPersistentSingletonCache<{ count: number }>('k1', { storage });
    expect(cache.get()).toBeUndefined();
    expect(cache.has()).toBe(false);
  });

  it('hydrates from a pre-existing localStorage entry on first get()', () => {
    const storage = fakeStorage();
    storage.setItem('k2', JSON.stringify({ count: 7 }));
    const cache = createPersistentSingletonCache<{ count: number }>('k2', { storage });
    expect(cache.get()).toEqual({ count: 7 });
    expect(cache.has()).toBe(true);
  });

  it('writes through on set() — a fresh cache instance can read what the previous wrote', () => {
    const storage = fakeStorage();
    const cacheA = createPersistentSingletonCache<{ count: number }>('k3', { storage });
    cacheA.set({ count: 42 });
    expect(storage._peek().k3).toBe('{"count":42}');
    const cacheB = createPersistentSingletonCache<{ count: number }>('k3', { storage });
    expect(cacheB.get()).toEqual({ count: 42 });
  });

  it('clear() wipes both in-memory and storage', () => {
    const storage = fakeStorage();
    const cache = createPersistentSingletonCache<{ count: number }>('k4', { storage });
    cache.set({ count: 1 });
    expect(storage._peek().k4).toBeDefined();
    cache.clear();
    expect(cache.get()).toBeUndefined();
    expect(cache.has()).toBe(false);
    expect(storage._peek().k4).toBeUndefined();
  });

  it('runs the validator on hydrate; rejection wipes the entry + acts as empty', () => {
    const storage = fakeStorage();
    storage.setItem('k5', JSON.stringify({ wrong: 'shape' }));
    const cache = createPersistentSingletonCache<{ count: number }>('k5', {
      storage,
      validate: raw => {
        const r = raw as { count?: unknown };
        return typeof r?.count === 'number' ? { count: r.count } : null;
      },
    });
    expect(cache.get()).toBeUndefined();
    expect(cache.has()).toBe(false);
    // Validator rejected → entry was wiped so we don't re-validate
    // bad data on every page load.
    expect(storage._peek().k5).toBeUndefined();
  });

  it('runs the validator on hydrate; acceptance unwraps the value', () => {
    const storage = fakeStorage();
    storage.setItem('k6', JSON.stringify({ count: 9 }));
    const cache = createPersistentSingletonCache<{ count: number }>('k6', {
      storage,
      validate: raw => {
        const r = raw as { count?: unknown };
        return typeof r?.count === 'number' ? { count: r.count } : null;
      },
    });
    expect(cache.get()).toEqual({ count: 9 });
  });

  it('malformed JSON in storage acts as empty + wipes the bad entry', () => {
    const storage = fakeStorage();
    storage.setItem('k7', 'not-json{{{');
    const cache = createPersistentSingletonCache<{ count: number }>('k7', { storage });
    expect(cache.get()).toBeUndefined();
    expect(storage._peek().k7).toBeUndefined();
  });

  it('storage that throws (private-mode Safari shape) degrades to in-memory-only', () => {
    const throwing = {
      getItem: () => { throw new Error('storage disabled'); },
      setItem: () => { throw new Error('storage disabled'); },
      removeItem: () => { throw new Error('storage disabled'); },
    };
    const cache = createPersistentSingletonCache<{ count: number }>('k8', { storage: throwing });
    // Hydrate is a no-op (the get throws internally; cache catches).
    expect(cache.get()).toBeUndefined();
    // set() degrades silently — in-memory still holds the value.
    cache.set({ count: 3 });
    expect(cache.get()).toEqual({ count: 3 });
  });

  it('hydrate runs once per cache instance — wiping storage after hydrate does not leak through', () => {
    const storage = fakeStorage();
    storage.setItem('k9', JSON.stringify({ count: 5 }));
    const cache = createPersistentSingletonCache<{ count: number }>('k9', { storage });
    expect(cache.get()).toEqual({ count: 5 });
    storage.removeItem('k9');
    // In-memory still holds the value — hydrate already happened.
    expect(cache.get()).toEqual({ count: 5 });
  });

  it('clearAllPersistentCaches wipes every registered cache — used on logout to prevent cross-user data leak', () => {
    // Note: the registry is module-scoped so other test files'
    // caches register too. We verify our own caches go from has=true
    // to has=false; we don't assert on the global set's count.
    const storage = fakeStorage();
    const cacheA = createPersistentSingletonCache<{ a: number }>('clear-test-a', { storage });
    const cacheB = createPersistentSingletonCache<{ b: number }>('clear-test-b', { storage });
    cacheA.set({ a: 1 });
    cacheB.set({ b: 2 });
    expect(cacheA.has()).toBe(true);
    expect(cacheB.has()).toBe(true);
    expect(storage._peek()['clear-test-a']).toBeDefined();
    expect(storage._peek()['clear-test-b']).toBeDefined();

    clearAllPersistentCaches();

    expect(cacheA.has()).toBe(false);
    expect(cacheB.has()).toBe(false);
    // Note: the test storage isn't passed through to other caches'
    // localStorage, so we can only verify the in-memory clear here.
    // The clear's localStorage write is covered by the per-cache
    // clear() test above.
  });
});
