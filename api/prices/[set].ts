import type { VercelRequest, VercelResponse } from '@vercel/node';

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

const VALID_SETS: Record<string, string> = {
  'spark-of-rebellion': 'Spark of Rebellion',
  'shadows-of-the-galaxy': 'Shadows of the Galaxy',
  'twilight-of-the-republic': 'Twilight of the Republic',
  'secrets-of-power': 'Secrets of Power',
  'legends-of-the-force': 'Legends of the Force',
  'jump-to-lightspeed': 'Jump to Lightspeed',
  'a-lawless-time': 'A Lawless Time',
};

interface CachedSet {
  data: CardData[];
  timestamp: number;
}

const cache: Record<string, CachedSet> = {};
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const TCGPLAYER_SEARCH_URL = 'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=true&mpfev=2952';

const PAGE_SIZE = 50;

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

function mapResult(item: any, setSlug: string, setName: string): CardData {
  const name = item.productName || '';
  return {
    name,
    variant: extractVariant(name),
    printing: item.foilOnly ? 'Foil' : 'Normal',
    rarity: item.rarityName || '',
    number: item.customAttributes?.number || '',
    marketPrice: typeof item.marketPrice === 'number' ? item.marketPrice : null,
    set: setSlug,
    setName,
    productId: String(Math.round(item.productId || 0)),
  };
}

async function fetchAllCards(setSlug: string, setName: string): Promise<CardData[]> {
  const allCards: CardData[] = [];
  let from = 0;
  let totalResults = Infinity;

  while (from < totalResults) {
    const res = await fetch(TCGPLAYER_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      body: buildSearchBody(setName, from),
    });

    if (!res.ok) {
      throw new Error(`TCGPlayer search API returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const resultSet = data.results?.[0];
    if (!resultSet) break;

    totalResults = resultSet.totalResults || 0;
    const results = resultSet.results || [];
    if (results.length === 0) break;

    for (const item of results) {
      allCards.push(mapResult(item, setSlug, setName));
    }

    from += PAGE_SIZE;
  }

  return allCards;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const setSlug = req.query.set as string;

  if (!setSlug || !VALID_SETS[setSlug]) {
    return res.status(400).json({
      error: 'Invalid set',
      validSets: Object.keys(VALID_SETS),
    });
  }

  // Check cache
  const cached = cache[setSlug];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json(cached.data);
  }

  const setName = VALID_SETS[setSlug];

  try {
    const cards = await fetchAllCards(setSlug, setName);

    // Cache the result in-memory (helps if the same instance is reused)
    cache[setSlug] = { data: cards, timestamp: Date.now() };

    // Cache at the CDN edge: serve stale for 30min, revalidate in background
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json(cards);
  } catch (error: any) {
    console.error(`Error fetching prices for ${setSlug}:`, error);
    return res.status(500).json({
      error: 'Failed to fetch prices',
      message: error.message,
    });
  }
}
