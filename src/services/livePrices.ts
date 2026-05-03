/**
 * Client-side live-price overlay. Single tiny store backing the
 * "card was added to a trade → fetch fresh price in the background"
 * UX. Three concerns, all module-scoped:
 *
 *   1. **Override map** — productId → { marketPrice, lowPrice,
 *      fetchedAt }. Components read from here first; if absent,
 *      they fall back to the static catalog.
 *   2. **Pending queue + debounce** — `enqueueRefresh(productId)`
 *      schedules a flush 250ms later. Multiple adds in the same
 *      window batch into one server request.
 *   3. **Reactivity** — a tiny pub-sub. `useLivePrice` /
 *      `useIsLivePriceRefreshing` subscribe and re-render when the
 *      relevant id updates.
 *
 * The module is a singleton — there's only one trade-builder UI at
 * a time and the override map is a global property of the running
 * tab. Persisted to localStorage with a 5-minute TTL on hydrate so
 * a page reload keeps the freshly-fetched data without re-hitting
 * the server immediately.
 *
 * Failure-mode posture: missing entries (server didn't return a
 * row, or fetch failed) are silently absent — components fall
 * through to the static catalog as if nothing happened. Best-
 * effort by design: the user never sees an error for "live price
 * unavailable" because they didn't ask for live prices, the app
 * implicitly tried to surface one.
 */

import { useEffect, useState } from 'react';

/** Match the server's wire shape exactly so we can JSON-cast on
 *  receive without normalizing. */
export interface LivePrice {
  marketPrice: number | null;
  lowPrice: number | null;
  /** ISO-8601 UTC. Server-side fetch timestamp, NOT client receive. */
  fetchedAt: string;
}

/** How long persisted entries are considered fresh on hydrate. The
 *  server-side cache TTL is 60s — a longer client-side TTL means a
 *  user who refreshes within 5 min sees their last-fetched values
 *  immediately while a background refresh loads in. */
const HYDRATE_TTL_MS = 5 * 60_000;

/** Debounce window for batching multiple `enqueueRefresh` calls
 *  into one server request. 250ms is short enough to feel instant
 *  on the next paint, long enough to batch cards added back-to-
 *  back during a manual proposal compose. */
const FLUSH_DEBOUNCE_MS = 250;

/** Hard cap on ids per server request. Mirrors the server-side
 *  PRICES_MAX_IDS constant. */
const MAX_BATCH_SIZE = 50;

/** localStorage key — versioned so a future format change can
 *  cleanly reset stored data without a parser-fragility window. */
const STORAGE_KEY = 'swu.livePrices.v1';

const overrides = new Map<string, LivePrice>();
const pendingQueue = new Set<string>();
const inFlight = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let hydrated = false;

type Listener = () => void;
const listeners = new Set<Listener>();

/** Internal: schedule listeners to fire on the next microtask so
 *  React batches re-renders even when multiple ids land at once. */
function notify() {
  queueMicrotask(() => {
    for (const fn of listeners) fn();
  });
}

/** Hydrate from localStorage. Idempotent; called lazily on first
 *  hook subscription so SSR / unit-test environments without
 *  `window` stay clean. */
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  if (typeof window === 'undefined') return;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Safari private mode etc. — silently skip.
    return;
  }
  if (!raw) return;
  let parsed: Record<string, LivePrice>;
  try {
    parsed = JSON.parse(raw) as Record<string, LivePrice>;
  } catch {
    return;
  }
  const cutoff = Date.now() - HYDRATE_TTL_MS;
  for (const [id, price] of Object.entries(parsed)) {
    const t = Date.parse(price.fetchedAt);
    if (!Number.isFinite(t) || t < cutoff) continue;
    overrides.set(id, price);
  }
}

function persist() {
  if (typeof window === 'undefined') return;
  try {
    const obj: Record<string, LivePrice> = {};
    for (const [id, price] of overrides.entries()) obj[id] = price;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // Quota exceeded / private mode — drop silently. Override map
    // still works for the rest of this session.
  }
}

/** Test/internal: read the current override for a productId. Lets
 *  tests assert on the store without renderHook. */
export function __getOverride(productId: string): LivePrice | null {
  return overrides.get(productId) ?? null;
}

/** Test/internal: read in-flight state for a productId. */
export function __isInFlight(productId: string): boolean {
  return inFlight.has(productId);
}

/** Test/internal: wipe the store. Used by the test suite between
 *  cases; production code shouldn't need this. */
export function __resetLivePrices(): void {
  overrides.clear();
  pendingQueue.clear();
  inFlight.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  hydrated = false;
  if (typeof window !== 'undefined') {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
  }
}

/** Fetch override for tests. Lets cases inject a mocked response
 *  shape without touching `global.fetch` (avoids interfering with
 *  any other fetches in the same test run). */
let fetchImpl: typeof fetch = (input, init) => fetch(input, init);
export function __setLivePricesFetch(impl: typeof fetch | null): void {
  fetchImpl = impl ?? ((input, init) => fetch(input, init));
}

/**
 * Queue an id for a background price refresh. Multiple calls
 * within the debounce window batch into one request; an id already
 * in flight or freshly cached (< HYDRATE_TTL_MS old) is ignored.
 *
 * Safe to call from render paths — purely synchronous; the
 * actual fetch fires on the next debounce tick.
 */
export function enqueueRefresh(productId: string | undefined | null): void {
  if (!productId) return;
  hydrate();
  if (inFlight.has(productId)) return;
  // Skip if we already have a fresh enough entry. Server-side cache
  // is 60s; if the client has anything fresher than HYDRATE_TTL_MS
  // we don't need to ask again.
  const existing = overrides.get(productId);
  if (existing) {
    const t = Date.parse(existing.fetchedAt);
    if (Number.isFinite(t) && Date.now() - t < HYDRATE_TTL_MS) return;
  }
  pendingQueue.add(productId);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, FLUSH_DEBOUNCE_MS);
}

/** Test/internal: trigger an immediate flush (skip the debounce). */
export async function __flushNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushQueue();
}

async function flushQueue(): Promise<void> {
  if (pendingQueue.size === 0) return;
  // Snapshot + clear the queue under a single tick so any new
  // enqueues that arrive during the request schedule a fresh flush.
  const ids = Array.from(pendingQueue).slice(0, MAX_BATCH_SIZE);
  for (const id of ids) {
    pendingQueue.delete(id);
    inFlight.add(id);
  }
  notify(); // surface in-flight state to subscribers (pulse UI).

  let prices: Record<string, LivePrice> = {};
  try {
    const url = `/api/prices?ids=${encodeURIComponent(ids.join(','))}`;
    const res = await fetchImpl(url);
    if (res.ok) {
      const body = await res.json() as { prices?: Record<string, LivePrice> };
      prices = body.prices ?? {};
    }
  } catch {
    // Network error — leave overrides untouched, fall through to
    // static catalog. Don't propagate the error to UI.
  } finally {
    for (const id of ids) inFlight.delete(id);
  }

  for (const [id, price] of Object.entries(prices)) {
    overrides.set(id, price);
  }
  persist();
  notify();

  // If new ids arrived during the request, schedule the next batch.
  if (pendingQueue.size > 0 && !flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushQueue();
    }, FLUSH_DEBOUNCE_MS);
  }
}

/** Component hook: subscribe to live-price changes for a given
 *  productId. Re-renders only when its specific id updates (or the
 *  in-flight state for that id flips). */
export function useLivePrice(productId: string | undefined | null): {
  livePrice: LivePrice | null;
  isRefreshing: boolean;
} {
  hydrate();
  const [, forceRender] = useState(0);
  useEffect(() => {
    if (!productId) return;
    let lastSeen = overrides.get(productId);
    let lastInFlight = inFlight.has(productId);
    const fn = () => {
      const next = overrides.get(productId);
      const inflightNow = inFlight.has(productId);
      // Cheap referential equality — entries are written as new
      // objects on each refresh so a changed productId always
      // produces a new reference.
      if (next === lastSeen && inflightNow === lastInFlight) return;
      lastSeen = next;
      lastInFlight = inflightNow;
      forceRender(n => n + 1);
    };
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, [productId]);

  if (!productId) return { livePrice: null, isRefreshing: false };
  return {
    livePrice: overrides.get(productId) ?? null,
    isRefreshing: inFlight.has(productId),
  };
}
