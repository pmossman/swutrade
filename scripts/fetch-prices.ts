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

function extractVariant(name: string): string {
  const match = name.match(/\(([^)]+)\)\s*$/);
  if (!match) return 'Standard';
  return match[1];
}

function buildSearchBody(setApiName: string, from: number): string {
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
        term: { sellerStatus: 'Live', channelId: 0 },
        range: { quantity: { gte: 1 }, directInventory: { gte: 1 } },
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

async function fetchAllCards(slug: string, apiName: string): Promise<CardData[]> {
  const allCards: CardData[] = [];
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
      allCards.push({
        name: item.productName || '',
        variant: extractVariant(item.productName || ''),
        printing: item.foilOnly ? 'Foil' : 'Normal',
        rarity: item.rarityName || '',
        number: item.customAttributes?.number || '',
        marketPrice: typeof item.marketPrice === 'number' ? item.marketPrice : null,
        lowPrice: typeof item.lowestPrice === 'number' ? item.lowestPrice : null,
        set: slug,
        setName: apiName,
        productId: String(Math.round(item.productId || 0)),
      });
    }

    from += PAGE_SIZE;
    // Small delay between pages to be polite
    if (from < totalResults) await sleep(200);
  }

  return allCards;
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
