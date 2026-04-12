/**
 * Build-time script: fetches all SWU card data from TCGPlayer
 * and writes static JSON files to public/data/.
 *
 * Run: npx tsx scripts/fetch-prices.ts
 */

// Import the canonical set list from the app types
import { SETS as ALL_SETS } from '../src/types/index.js';

// Build a slug → name mapping from the canonical set list
const SETS: Record<string, string> = Object.fromEntries(
  ALL_SETS.map(s => [s.slug, s.name])
);

const TCGPLAYER_SEARCH_URL =
  'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=true&mpfev=2952';
const PAGE_SIZE = 50;

interface CardData {
  name: string;
  variant: string;
  printing: string;
  rarity: string;
  number: string;
  marketPrice: number | null;
  set: string;
  setName: string;
  productId: string;
}

function extractVariant(name: string): string {
  const match = name.match(/\(([^)]+)\)\s*$/);
  if (!match) return 'Standard';
  return match[1];
}

function buildSearchBody(setName: string, from: number): string {
  return JSON.stringify({
    algorithm: '',
    from,
    size: PAGE_SIZE,
    filters: {
      term: {
        productLineName: ['star-wars-unlimited'],
        setName: [setName],
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

async function fetchAllCards(setSlug: string, setName: string): Promise<CardData[]> {
  const allCards: CardData[] = [];
  let from = 0;
  let totalResults = Infinity;

  while (from < totalResults) {
    const res = await fetchWithRetry(TCGPLAYER_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      body: buildSearchBody(setName, from),
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
        set: setSlug,
        setName,
        productId: String(Math.round(item.productId || 0)),
      });
    }

    from += PAGE_SIZE;
    // Small delay between pages to be polite
    if (from < totalResults) await sleep(200);
  }

  return allCards;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Query TCGPlayer aggregations to discover all SWU set names */
async function discoverSets(): Promise<Record<string, string>> {
  const res = await fetchWithRetry(TCGPLAYER_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
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
  const aggs = data.results?.[0]?.aggregations;
  if (!aggs) return {};

  const setAgg = aggs.setName;
  if (!Array.isArray(setAgg)) return {};

  const discovered: Record<string, string> = {};
  for (const item of setAgg) {
    const name = item.value || item.urlValue;
    if (!name) continue;
    const slug = item.urlValue || slugify(name);
    discovered[slug] = name;
  }
  return discovered;
}

async function main() {
  const { mkdirSync, writeFileSync } = await import('fs');
  const { join } = await import('path');

  const outDir = join(import.meta.dirname, '..', 'public', 'data');
  mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString();
  console.log(`Fetching prices at ${timestamp}...`);

  // Discover all sets from TCGPlayer and merge with our known list
  console.log('Discovering sets from TCGPlayer...');
  const discovered = await discoverSets();
  const allSets = { ...SETS };
  const newSets: string[] = [];

  for (const [slug, name] of Object.entries(discovered)) {
    if (!allSets[slug]) {
      allSets[slug] = name;
      newSets.push(`${slug} (${name})`);
    }
  }

  if (newSets.length > 0) {
    console.log(`\n⚠️  Found ${newSets.length} new set(s) not in types/index.ts:`);
    newSets.forEach(s => console.log(`    - ${s}`));
    console.log('  Auto-including them for this build. Add them to src/types/index.ts for proper support.\n');
  }

  console.log(`Fetching ${Object.keys(allSets).length} sets...`);

  const manifest: Record<string, { cards: number }> = {};

  const entries = Object.entries(allSets);
  for (let i = 0; i < entries.length; i++) {
    const [slug, name] = entries[i];
    process.stdout.write(`  ${slug}...`);
    const cards = await fetchAllCards(slug, name);
    if (cards.length === 0) {
      console.log(' 0 cards (skipping)');
      continue;
    }
    writeFileSync(join(outDir, `${slug}.json`), JSON.stringify(cards));
    manifest[slug] = { cards: cards.length };
    console.log(` ${cards.length} cards`);
    // Pause between sets to avoid rate limiting
    if (i < entries.length - 1) await sleep(1000);
  }

  // Write manifest with timestamp
  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify({ timestamp, sets: manifest }, null, 2),
  );

  console.log(`Done. Wrote ${Object.keys(manifest).length} sets + manifest to public/data/`);
}

main().catch(err => {
  console.error('Failed to fetch prices:', err);
  process.exit(1);
});
