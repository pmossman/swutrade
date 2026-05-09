/**
 * Build-time script: fetches all SWU card data from TCGPlayer
 * and writes static JSON files to public/data/.
 *
 * Discovers all sets dynamically from TCGPlayer's API aggregations,
 * so new sets are automatically included without code changes.
 *
 * Run: npx tsx scripts/fetch-prices.ts
 */

import { SETS as KNOWN_SETS } from '../src/types/index.js';

const TCGPLAYER_SEARCH_URL =
  'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=true&mpfev=2952';
const PAGE_SIZE = 50;

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

interface CardData {
  name: string;
  variant: string;
  printing: string;
  rarity: string;
  number: string;
  marketPrice: number | null;
  lowPrice: number | null;
  set: string;
  setName: string;
  productId: string;
}

interface DiscoveredSet {
  slug: string;
  apiName: string; // Exact name for the TCGPlayer API filter
}

// Mirror of src/variants.ts::extractVariantLabel. Kept in sync manually
// since scripts/ runs under tsx without the app's module resolution.
// Numeric parentheticals like "(77)" are SRP / OPP regional-prize
// collector indices — not variants — so we collapse them to the
// "Regional" label used by variantBadgeColor.
function extractVariant(name: string): string {
  const match = name.match(/\(([^)]+)\)\s*$/);
  if (!match) return 'Standard';
  const raw = match[1];
  if (/^\d+$/.test(raw)) return 'Regional';
  return raw;
}

function buildSearchBody(
  setApiName: string,
  from: number,
  opts: { foilListingsOnly?: boolean } = {},
): string {
  const listingTermBase: Record<string, unknown> = {
    sellerStatus: 'Live',
    channelId: 0,
  };
  // foilListingsOnly: filters listingSearch to printing=Foil. We use
  // this for the Foil-discovery pass on sets where Foil printings
  // exist as listings under the same productId as Normal (TWI-era
  // schema). Newer sets — JTL, SHD, SEC, LAW — already split each
  // foil into its own productId, so the second pass returns nothing
  // new for them.
  if (opts.foilListingsOnly) listingTermBase.printing = ['Foil'];
  return JSON.stringify({
    algorithm: '',
    from,
    size: PAGE_SIZE,
    filters: {
      term: {
        productLineName: ['star-wars-unlimited'],
        setName: [setApiName],
      },
      range: {},
      match: {},
    },
    listingSearch: {
      filters: {
        term: listingTermBase,
        // `quantity >= 1` only — no `directInventory` floor. Adding
        // the directInventory requirement silently dropped products
        // that are listed by non-Direct sellers but happen to have
        // zero Direct stock at scrape time (Luke Hyperspace is one
        // such case). The catalog should be comprehensive of "any
        // seller has at least one for sale" rather than "Direct has
        // stock right now."
        range: { quantity: { gte: 1 } },
        exclude: { channelExclusion: 0 },
      },
      context: { cart: {} },
    },
    context: { cart: {}, shippingCountry: 'US', userProfile: {} },
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url: string, opts: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, opts);
    if (res.ok) return res;
    if (res.status >= 500 && i < retries - 1) {
      console.warn(` (${res.status}, retrying in ${(i + 1) * 2}s...)`);
      await sleep((i + 1) * 2000);
      continue;
    }
    throw new Error(`TCGPlayer API returned ${res.status}: ${res.statusText}`);
  }
  throw new Error('Unreachable');
}

/** Query TCGPlayer aggregations to discover all SWU sets with their exact API names */
async function discoverSets(): Promise<DiscoveredSet[]> {
  const res = await fetchWithRetry(TCGPLAYER_SEARCH_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      algorithm: '',
      from: 0,
      size: 0,
      filters: {
        term: { productLineName: ['star-wars-unlimited'] },
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
    }),
  });

  const data: any = await res.json();
  const setAgg = data.results?.[0]?.aggregations?.setName;
  if (!Array.isArray(setAgg)) {
    throw new Error('Could not discover sets from TCGPlayer aggregations');
  }

  return setAgg.map((item: any) => ({
    slug: item.urlValue,
    apiName: item.value, // The exact name TCGPlayer uses in its API
  }));
}

/**
 * Internal-key helper. Records that share a TCGPlayer productId
 * (the TWI-era pattern where a single product is sold in both
 * Normal and Foil printings via the listings, not via separate
 * productIds) are disambiguated by suffixing the synthetic Foil
 * record's productId with `:foil`. Code that needs the raw
 * TCGPlayer numeric id (for image URLs, TCGPlayer page links)
 * strips the suffix via `tcgProductId()` in lib/shared.ts.
 */
const FOIL_KEY_SUFFIX = ':foil';

interface FoilStats {
  /** Min listing price across foil listings — the "low" channel. */
  lowPrice: number | null;
  /** Median listing price across foil listings — our best
   *  approximation of "market price" for the foil printing,
   *  since TCGPlayer's search API only returns one product-level
   *  marketPrice (always the Normal one). */
  marketPrice: number | null;
}

function computeFoilStats(listings: Array<{ price?: number }>): FoilStats {
  const prices = listings
    .map(l => (typeof l.price === 'number' ? l.price : null))
    .filter((p): p is number => p !== null && Number.isFinite(p));
  if (prices.length === 0) return { lowPrice: null, marketPrice: null };
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return {
    lowPrice: sorted[0],
    marketPrice: Math.round(median * 100) / 100,
  };
}

/**
 * Synthesize a Foil record from a Normal product that has Foil
 * listings on it. The name + variant follow the convention used
 * elsewhere in our catalog: a Standard Normal product becomes a
 * "(Foil)" variant; a non-Standard one (Hyperspace, Showcase, …)
 * becomes "(Hyperspace Foil)" / "(Showcase Foil)" / etc.
 *
 * Returns null when synthesis would be a no-op or wrong:
 *   - source product is itself foil-only (already a foil)
 *   - source variant name already contains "Foil" — synthesizing on
 *     top would produce "(Foil Foil)" / "(Prestige Foil Foil)"
 *     garbage. SEC-era products with dedicated foil productIds still
 *     have foil LISTINGS too (they have foil-of-foil), but those
 *     aren't a meaningful catalog entry.
 *   - source variant is "Serialized" — serialized printings are
 *     foil-by-convention in SWU; the "(Serialized Foil)" synth
 *     duplicates rather than disambiguates.
 */
function synthesizeFoilRecord(
  normal: CardData,
  foilListings: Array<{ price?: number }>,
): CardData | null {
  if (normal.printing === 'Foil') return null;
  if (/foil/i.test(normal.variant)) return null;
  if (normal.variant === 'Serialized') return null;

  const stats = computeFoilStats(foilListings);
  if (stats.lowPrice === null && stats.marketPrice === null) return null;

  // Naming convention. Standard becomes "(Foil)"; non-Standard
  // wraps the existing variant in "(... Foil)".
  const newName = normal.variant === 'Standard'
    ? `${normal.name} (Foil)`
    : normal.name.replace(/\([^)]+\)\s*$/, `(${normal.variant} Foil)`);
  const newVariant = normal.variant === 'Standard'
    ? 'Foil'
    : `${normal.variant} Foil`;

  return {
    name: newName,
    variant: newVariant,
    printing: 'Foil',
    rarity: normal.rarity,
    number: normal.number,
    marketPrice: stats.marketPrice,
    lowPrice: stats.lowPrice,
    set: normal.set,
    setName: normal.setName,
    productId: `${normal.productId}${FOIL_KEY_SUFFIX}`,
  };
}

async function fetchAllCards(slug: string, apiName: string): Promise<CardData[]> {
  // First pass: discover all products in the set with their default
  // (Normal, or Foil-only when foilOnly=true) listings.
  //
  // TCGPlayer's paginated search occasionally returns the same productId
  // on more than one page (relevance-sorted pagination isn't stable when
  // new listings come online mid-query). Dedupe by productId while
  // ingesting — first occurrence wins. Conflicting prices across
  // duplicates would indicate stale cache; log loudly if it happens.
  const byProductId = new Map<string, CardData>();
  let from = 0;
  let totalResults = Infinity;

  while (from < totalResults) {
    const res = await fetchWithRetry(TCGPLAYER_SEARCH_URL, {
      method: 'POST',
      headers: HEADERS,
      body: buildSearchBody(apiName, from),
    });

    const data: any = await res.json();
    const resultSet = data.results?.[0];
    if (!resultSet) break;

    totalResults = resultSet.totalResults || 0;
    const results = resultSet.results || [];
    if (results.length === 0) break;

    for (const item of results) {
      const name = item.productName || '';
      const productId = String(Math.round(item.productId || 0));
      if (!productId || productId === '0') continue;
      const card: CardData = {
        name,
        variant: extractVariant(name),
        printing: item.foilOnly ? 'Foil' : 'Normal',
        rarity: item.rarityName || '',
        number: item.customAttributes?.number || '',
        marketPrice: typeof item.marketPrice === 'number' ? item.marketPrice : null,
        lowPrice: typeof item.lowestPrice === 'number' ? item.lowestPrice : null,
        set: slug,
        setName: apiName,
        productId,
      };
      const existing = byProductId.get(productId);
      if (existing) {
        if (existing.marketPrice !== card.marketPrice || existing.lowPrice !== card.lowPrice) {
          console.warn(
            `  ! duplicate productId ${productId} with divergent prices in ${slug} — keeping first`,
          );
        }
        continue;
      }
      byProductId.set(productId, card);
    }

    from += PAGE_SIZE;
    // Small delay between pages to be polite
    if (from < totalResults) await sleep(200);
  }

  // Second pass: surface Foil printings carried as listings on the
  // SAME productId as Normal (TWI-era schema). Newer sets (JTL,
  // SHD, SEC, LAW) split each foil into its own productId so this
  // pass returns nothing new for them — the dedup-by-existing-foil-
  // record check below skips. The only cost is one extra paginated
  // query per set + one synthesized record per non-foil-only product
  // that happens to have foil listings.
  const foilByProductId = new Map<string, Array<{ price?: number }>>();
  from = 0;
  totalResults = Infinity;
  while (from < totalResults) {
    const res = await fetchWithRetry(TCGPLAYER_SEARCH_URL, {
      method: 'POST',
      headers: HEADERS,
      body: buildSearchBody(apiName, from, { foilListingsOnly: true }),
    });
    const data: any = await res.json();
    const resultSet = data.results?.[0];
    if (!resultSet) break;
    totalResults = resultSet.totalResults || 0;
    const results = resultSet.results || [];
    if (results.length === 0) break;
    for (const item of results) {
      const productId = String(Math.round(item.productId || 0));
      if (!productId || productId === '0') continue;
      const listings = Array.isArray(item.listings) ? item.listings : [];
      if (listings.length === 0) continue;
      foilByProductId.set(productId, listings);
    }
    from += PAGE_SIZE;
    if (from < totalResults) await sleep(200);
  }

  // Synthesize Foil records. Skip when the source is itself foil-
  // only, when the foil derivation produced no usable price, or
  // when a sibling product with the foil-equivalent name already
  // exists (e.g. SEC has a separate "Cad Bane (Foil)" productId
  // — the foil-listings pass returns it too, but we don't want to
  // emit a synthetic record that competes with the real one).
  const existingNames = new Set(
    Array.from(byProductId.values()).map(c => c.name),
  );
  let synthesizedFoils = 0;
  for (const [productId, foilListings] of foilByProductId) {
    const normal = byProductId.get(productId);
    if (!normal) continue;
    const synth = synthesizeFoilRecord(normal, foilListings);
    if (!synth) continue;
    if (existingNames.has(synth.name)) continue;
    byProductId.set(synth.productId, synth);
    synthesizedFoils += 1;
  }
  if (synthesizedFoils > 0) {
    console.log(`  + ${synthesizedFoils} synthesized Foil record(s) (TWI-era same-productId pattern)`);
  }

  return Array.from(byProductId.values());
}

async function main() {
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');

  const outDir = join(import.meta.dirname, '..', 'public', 'data');
  mkdirSync(outDir, { recursive: true });

  // Skip the fetch when we already have data, unless explicitly forced.
  // Vercel build cache restores `public/data/` between deploys, so a normal
  // build skips this step entirely (~5min → seconds). Trigger a refresh with
  // FETCH_PRICES=1 (e.g. via cron) when prices need updating.
  const force = process.env.FETCH_PRICES === '1' || process.argv.includes('--force');
  const manifestPath = join(outDir, 'manifest.json');
  if (!force && existsSync(manifestPath) && existsSync(join(outDir, 'product-index.json'))) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    console.log(`Skipping price fetch — reusing data from ${existing.timestamp} (set FETCH_PRICES=1 to refresh).`);
    return;
  }

  const timestamp = new Date().toISOString();
  console.log(`Fetching prices at ${timestamp}...`);

  // Discover all sets directly from TCGPlayer with exact API names
  console.log('Discovering sets from TCGPlayer...');
  const discovered = await discoverSets();
  console.log(`Found ${discovered.length} sets on TCGPlayer.`);

  // Check for sets we don't have in our types
  const knownSlugs = new Set(KNOWN_SETS.map(s => s.slug));
  const newSets = discovered.filter(s => !knownSlugs.has(s.slug));
  if (newSets.length > 0) {
    console.log(`\n⚠️  ${newSets.length} new set(s) not in src/types/index.ts:`);
    newSets.forEach(s => console.log(`    - ${s.slug} ("${s.apiName}")`));
    console.log('  Auto-including them. Add to src/types/index.ts for proper display names/codes.\n');
  }

  const manifest: Record<string, { cards: number }> = {};

  for (let i = 0; i < discovered.length; i++) {
    const { slug, apiName } = discovered[i];
    process.stdout.write(`  ${slug}...`);
    const cards = await fetchAllCards(slug, apiName);
    if (cards.length === 0) {
      console.log(' 0 cards (skipping)');
      continue;
    }
    writeFileSync(join(outDir, `${slug}.json`), JSON.stringify(cards));
    manifest[slug] = { cards: cards.length };
    console.log(` ${cards.length} cards`);
    // Pause between sets to avoid rate limiting
    if (i < discovered.length - 1) await sleep(1000);
  }

  // Write manifest with timestamp
  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify({ timestamp, sets: manifest }, null, 2),
  );

  // Build a compact product-id → card-info index for OG image generation
  const productIndex: Record<string, { n: string; p: number | null; l: number | null; s: string }> = {};
  for (const slug of Object.keys(manifest)) {
    const setPath = join(outDir, `${slug}.json`);
    const cards: CardData[] = JSON.parse(readFileSync(setPath, 'utf-8'));
    for (const card of cards) {
      if (card.productId) {
        productIndex[card.productId] = {
          n: card.name,
          p: card.marketPrice,
          l: card.lowPrice,
          s: card.setName,
        };
      }
    }
  }
  writeFileSync(join(outDir, 'product-index.json'), JSON.stringify(productIndex));
  console.log(`Done. Wrote ${Object.keys(manifest).length} sets + manifest + product index to public/data/`);
}

main().catch(err => {
  console.error('Failed to fetch prices:', err);
  process.exit(1);
});
