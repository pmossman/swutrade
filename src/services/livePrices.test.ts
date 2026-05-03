import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// vitest defaults to a node environment, which has no window /
// localStorage. The persistence tests below need them; install a
// Map-backed shim once before the suite. The livePrices module
// guards on `typeof window !== 'undefined'`, so without this it'd
// just no-op the persistence path silently and we couldn't assert.
beforeAll(() => {
  if (typeof globalThis.window === 'undefined') {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
        get length() { return store.size; },
        key: (i: number) => Array.from(store.keys())[i] ?? null,
      },
    };
  }
});

import {
  __flushNow,
  __getOverride,
  __isInFlight,
  __resetLivePrices,
  __setLivePricesFetch,
  enqueueRefresh,
} from './livePrices';

/**
 * Coverage for the client-side live-price store. The hook (`useLivePrice`)
 * is a thin shim over `__getOverride` + subscriber notifications;
 * these tests target the state machine directly via the test-only
 * accessors so we don't need a React renderer.
 *
 * Test contract:
 *   - debounced batching: multiple enqueues = one request.
 *   - dedup: enqueueing an id with a fresh override skips fetch.
 *   - dedup: enqueueing an id already in-flight skips re-fetch.
 *   - persistence: writes flow to localStorage.
 *   - persistence: hydrate ignores entries past the 5-min TTL.
 *   - failure path: fetch error / non-2xx leaves overrides untouched.
 */

beforeEach(() => {
  __resetLivePrices();
  __setLivePricesFetch(null);
  if (typeof window !== 'undefined') {
    try { window.localStorage.clear(); } catch { /* noop */ }
  }
});

function mockFetch(prices: Record<string, { marketPrice: number | null; lowPrice: number | null }>) {
  return vi.fn().mockResolvedValue(new Response(
    JSON.stringify({
      prices: Object.fromEntries(
        Object.entries(prices).map(([id, p]) => [id, { ...p, fetchedAt: new Date().toISOString() }]),
      ),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
}

describe('livePrices', () => {
  it('batches multiple enqueueRefresh calls into one server request', async () => {
    const fetchSpy = mockFetch({
      '111': { marketPrice: 1.5, lowPrice: 1.0 },
      '222': { marketPrice: 5.0, lowPrice: 3.5 },
      '333': { marketPrice: 10.0, lowPrice: 8.0 },
    });
    __setLivePricesFetch(fetchSpy as unknown as typeof fetch);

    enqueueRefresh('111');
    enqueueRefresh('222');
    enqueueRefresh('333');

    await __flushNow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/^\/api\/prices\?ids=/);
    const parsedIds = new URL(url, 'http://localhost').searchParams.get('ids')!.split(',').sort();
    expect(parsedIds).toEqual(['111', '222', '333']);
    // Overrides land for all three.
    expect(__getOverride('111')?.marketPrice).toBe(1.5);
    expect(__getOverride('333')?.lowPrice).toBe(8.0);
  });

  it('skips a productId that already has a fresh override', async () => {
    const fetchSpy = mockFetch({
      '111': { marketPrice: 1.5, lowPrice: 1.0 },
    });
    __setLivePricesFetch(fetchSpy as unknown as typeof fetch);

    enqueueRefresh('111');
    await __flushNow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Within the freshness window — second enqueue is a no-op.
    enqueueRefresh('111');
    await __flushNow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('skips a productId that is already in flight (concurrent enqueue)', async () => {
    let resolveBatch: (r: Response) => void = () => {};
    const fetchSpy = vi.fn().mockReturnValueOnce(new Promise<Response>(r => { resolveBatch = r; }));
    __setLivePricesFetch(fetchSpy as unknown as typeof fetch);

    enqueueRefresh('111');
    // Trigger the flush but don't await — '111' is now in-flight.
    const flushPromise = __flushNow();

    // Yield a tick so the queue is drained into inFlight.
    await Promise.resolve();
    expect(__isInFlight('111')).toBe(true);

    // Concurrent enqueue while in flight should be skipped.
    enqueueRefresh('111');

    resolveBatch(new Response(
      JSON.stringify({ prices: { '111': { marketPrice: 1.5, lowPrice: 1.0, fetchedAt: new Date().toISOString() } } }),
      { status: 200 },
    ));
    await flushPromise;

    // Only the original flush fired.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(__isInFlight('111')).toBe(false);
    expect(__getOverride('111')?.marketPrice).toBe(1.5);
  });

  it('persists fresh writes to localStorage', async () => {
    const fetchSpy = mockFetch({
      '111': { marketPrice: 1.5, lowPrice: 1.0 },
    });
    __setLivePricesFetch(fetchSpy as unknown as typeof fetch);

    enqueueRefresh('111');
    await __flushNow();

    const stored = window.localStorage.getItem('swu.livePrices.v1');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed['111'].marketPrice).toBe(1.5);
    expect(parsed['111'].lowPrice).toBe(1.0);
  });

  it('hydrates fresh entries from localStorage; drops entries past 5-min TTL', async () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    window.localStorage.setItem('swu.livePrices.v1', JSON.stringify({
      '111': { marketPrice: 1.5, lowPrice: 1.0, fetchedAt: fresh },
      '999': { marketPrice: 9.99, lowPrice: 9.0, fetchedAt: stale },
    }));

    // Trigger hydrate by enqueueing (which calls hydrate() lazily).
    // Use a never-resolving fetch so we can assert state pre-flush.
    __setLivePricesFetch((() => new Promise(() => {})) as unknown as typeof fetch);
    enqueueRefresh('999'); // forces hydrate

    expect(__getOverride('111')?.marketPrice).toBe(1.5);
    expect(__getOverride('999')).toBeNull();
  });

  it('fetch failure leaves overrides untouched (best-effort posture)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'));
    __setLivePricesFetch(fetchSpy as unknown as typeof fetch);

    enqueueRefresh('111');
    await __flushNow();
    expect(__getOverride('111')).toBeNull();
    expect(__isInFlight('111')).toBe(false);
  });

  it('non-2xx response leaves overrides untouched', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
    __setLivePricesFetch(fetchSpy as unknown as typeof fetch);

    enqueueRefresh('111');
    await __flushNow();
    expect(__getOverride('111')).toBeNull();
  });

  it('null / undefined / empty productId is a no-op', () => {
    const fetchSpy = vi.fn();
    __setLivePricesFetch(fetchSpy as unknown as typeof fetch);
    enqueueRefresh(null);
    enqueueRefresh(undefined);
    enqueueRefresh('');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('omits productIds the server did not return (caller falls back to static)', async () => {
    const fetchSpy = mockFetch({
      '111': { marketPrice: 1.5, lowPrice: 1.0 },
      // '999' intentionally absent — server had no row.
    });
    __setLivePricesFetch(fetchSpy as unknown as typeof fetch);

    enqueueRefresh('111');
    enqueueRefresh('999');
    await __flushNow();

    expect(__getOverride('111')?.marketPrice).toBe(1.5);
    expect(__getOverride('999')).toBeNull();
  });
});
