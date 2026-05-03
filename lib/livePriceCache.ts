/**
 * Server-side live-price overlay against TCGPlayer's marketplace
 * search API. Companion to the bi-hourly bulk fetch in
 * `scripts/fetch-prices.ts` — same upstream endpoint, narrower
 * filter (`productId` term), one batched request per cache-miss
 * flush regardless of how many ids the caller asks about.
 *
 * Why this exists: the bulk fetch rebuilds `public/data/*.json` via
 * a Vercel deploy every 2 hours. Hot-tier cards (≥ $5, ~12% of
 * catalog by count, ~91% by dollar value) drift meaningfully inside
 * that window. This cache lets users refresh prices on demand for
 * specific cards (e.g. as soon as they're added to a trade) without
 * needing a deploy.
 *
 * Three guarantees:
 *   1. **TTL cache** — same productId served from memory for
 *      `CACHE_TTL_MS`. Keeps the upstream load proportional to
 *      *distinct* hot cards, not request volume.
 *   2. **In-flight dedup** — concurrent callers asking about the
 *      same uncached productId share one upstream Promise. Without
 *      this, a popular card spike triggers a thundering herd against
 *      TCGPlayer.
 *   3. **Batched upstream call** — every cache-miss flush hits
 *      TCGPlayer once with all missing ids in the term filter. The
 *      bulk script's same endpoint accepts an array term — verified
 *      via spike.
 *
 * Failure mode: TCGPlayer null `lowestPrice` (no live listings) does
 * NOT overwrite the cached low. We keep whatever value we last had,
 * because "no listings right now" doesn't mean the card is free.
 *
 * Memory footprint: the cache lives per Vercel function instance;
 * Fluid Compute reuses instances across concurrent requests so the
 * cache is shared. Cold-start instances start empty; that's fine —
 * first hit re-warms.
 */

const TCGPLAYER_SEARCH_URL =
  'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=true&mpfev=2952';

/** How long a fetched price counts as fresh. 60s lets a popular hot
 *  card ride through ~1 upstream call/min regardless of how many
 *  users open the trade builder simultaneously. */
const CACHE_TTL_MS = 60_000;

/** Upper bound on ids per batched upstream call. The endpoint
 *  accepts more, but we slice to keep individual responses small. */
const MAX_BATCH_SIZE = 50;

export interface LivePrice {
  /** TCGPlayer marketplace `marketPrice`. Null when TCGPlayer's
   *  algorithm returned no value (rare; a card with no recent
   *  listings/sales). */
  marketPrice: number | null;
  /** TCGPlayer marketplace `lowestPrice`. Null when no live listings
   *  exist. Callers should fall back to the static catalog low rather
   *  than display "no price." */
  lowPrice: number | null;
  /** Server-side timestamp at fetch. Lets clients age out stale
   *  entries from their persisted overlay. ISO-8601 UTC. */
  fetchedAt: string;
}

interface CacheEntry {
  price: LivePrice;
  /** epoch ms; entries past `expiresAt` are treated as misses. */
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** In-flight upstream calls keyed by productId. Lets concurrent
 *  callers awaiting the same id share one Promise. */
const inflight = new Map<string, Promise<LivePrice | null>>();

/** Test-only: reset internal state between cases. */
export function __resetLivePriceCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Resolve live prices for a set of productIds. Cache-fresh ids
 * return synchronously from the in-memory map; the rest are
 * batched into one upstream TCGPlayer request. Returns a map of
 * productId → LivePrice. Missing ids (upstream had no row) simply
 * absent from the result; the API handler decides how to surface.
 */
export async function resolveLivePrices(
  ids: ReadonlyArray<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, LivePrice>> {
  const result = new Map<string, LivePrice>();
  if (ids.length === 0) return result;

  const now = Date.now();
  const missing: string[] = [];
  // Track per-id Promise (live cache or in-flight) so we can await
  // them all at once instead of N awaits in series.
  const pending: Array<Promise<{ id: string; price: LivePrice | null }>> = [];

  for (const id of ids) {
    const entry = cache.get(id);
    if (entry && entry.expiresAt > now) {
      result.set(id, entry.price);
      continue;
    }
    // In-flight dedup: another caller is already fetching this id;
    // we await their Promise instead of starting our own.
    const existing = inflight.get(id);
    if (existing) {
      pending.push(existing.then(price => ({ id, price })));
      continue;
    }
    missing.push(id);
  }

  // Batch the genuine cache misses into one upstream call. Every
  // missing id gets the same shared Promise so concurrent callers
  // arriving in the same tick see the dedup take effect.
  if (missing.length > 0) {
    const batchPromise = fetchBatch(missing, fetchImpl);
    for (const id of missing) {
      const idPromise = batchPromise.then(map => map.get(id) ?? null);
      inflight.set(id, idPromise);
      pending.push(idPromise.then(price => ({ id, price })));
    }
    // Once the batch settles, prune the in-flight entries so a
    // subsequent burst doesn't read a stale Promise.
    batchPromise.finally(() => {
      for (const id of missing) inflight.delete(id);
    });
  }

  const settled = await Promise.all(pending);
  for (const { id, price } of settled) {
    if (price) result.set(id, price);
  }

  // Write fresh entries back into the TTL cache.
  for (const [id, price] of result.entries()) {
    cache.set(id, { price, expiresAt: now + CACHE_TTL_MS });
  }

  return result;
}

interface TcgPlayerResult {
  productId: number | string;
  marketPrice: number | null;
  lowestPrice: number | null;
}

interface TcgPlayerSearchResponse {
  results?: Array<{
    totalResults?: number;
    results?: TcgPlayerResult[];
  }>;
}

/** One upstream batched call against TCGPlayer's marketplace search
 *  API, scoped to the SWU product line. Returns a map keyed by
 *  productId (string) → LivePrice. Productids missing from the
 *  response are silently absent — caller treats as "TCGPlayer has
 *  no price for this id right now," fall back to static catalog. */
async function fetchBatch(
  ids: ReadonlyArray<string>,
  fetchImpl: typeof fetch,
): Promise<Map<string, LivePrice>> {
  const result = new Map<string, LivePrice>();
  // Slice in case the API handler ever loosens the input cap; we
  // want each upstream call's response to stay reasonably bounded.
  const slice = ids.slice(0, MAX_BATCH_SIZE);

  const body = JSON.stringify({
    algorithm: '',
    from: 0,
    size: slice.length,
    filters: {
      term: {
        productLineName: ['star-wars-unlimited'],
        productId: slice,
      },
      range: {},
      match: {},
    },
    listingSearch: {
      filters: {
        term: { sellerStatus: 'Live', channelId: 0 },
        range: { quantity: { gte: 1 }, directInventory: { gte: 1 } },
        exclude: { channelExclusion: 0 },
      },
      context: { cart: {} },
    },
    context: { cart: {}, shippingCountry: 'US', userProfile: {} },
  });

  let res: Response;
  try {
    res = await fetchImpl(TCGPLAYER_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Same UA as the bulk fetch script — TCGPlayer hasn't
        // explicitly required this but matching what their site
        // sends keeps us indistinguishable from normal traffic.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body,
    });
  } catch (err) {
    // Network failure: log + return empty so callers fall back to
    // static catalog prices. Don't blow up the whole API request.
    console.error('livePriceCache: TCGPlayer fetch failed', err);
    return result;
  }

  if (!res.ok) {
    console.error('livePriceCache: TCGPlayer returned non-2xx', res.status);
    return result;
  }

  let data: TcgPlayerSearchResponse;
  try {
    data = (await res.json()) as TcgPlayerSearchResponse;
  } catch (err) {
    console.error('livePriceCache: TCGPlayer response not JSON', err);
    return result;
  }

  const rows = data.results?.[0]?.results ?? [];
  const fetchedAt = new Date().toISOString();
  for (const row of rows) {
    const id = String(Math.round(typeof row.productId === 'number' ? row.productId : Number(row.productId) || 0));
    if (!id || id === '0') continue;
    result.set(id, {
      marketPrice: typeof row.marketPrice === 'number' ? row.marketPrice : null,
      lowPrice: typeof row.lowestPrice === 'number' ? row.lowestPrice : null,
      fetchedAt,
    });
  }
  return result;
}
