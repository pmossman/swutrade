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

interface CardGroup {
  baseName: string;
  variants: CardData[];
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

const TCGPLAYER_SEARCH_URL = 'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=true&mpfev=2952';

function extractVariant(name: string): string {
  const match = name.match(/\(([^)]+)\)\s*$/);
  if (!match) return 'Standard';
  return match[1];
}

function extractBaseName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

async function searchTcgPlayer(query: string, setNames: string[]): Promise<CardData[]> {
  // Build a search that uses TCGPlayer's search with the query text
  const body = JSON.stringify({
    algorithm: '',
    from: 0,
    size: 50,
    filters: {
      term: {
        productLineName: ['star-wars-unlimited'],
        ...(setNames.length === 1 ? { setName: setNames } : {}),
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

  const searchUrl = `https://mp-search-api.tcgplayer.com/v1/search/request?q=${encodeURIComponent(query)}&isList=true&mpfev=2952`;

  const res = await fetch(searchUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
    body,
  });

  if (!res.ok) throw new Error(`TCGPlayer API returned ${res.status}`);

  const data = await res.json();
  const results = data.results?.[0]?.results || [];

  // Map set name to slug
  const slugByName: Record<string, string> = {};
  for (const [slug, name] of Object.entries(VALID_SETS)) {
    slugByName[name] = slug;
  }

  return results.map((item: any): CardData => ({
    name: item.productName || '',
    variant: extractVariant(item.productName || ''),
    printing: item.foilOnly ? 'Foil' : 'Normal',
    rarity: item.rarityName || '',
    number: item.customAttributes?.number || '',
    marketPrice: typeof item.marketPrice === 'number' ? item.marketPrice : null,
    set: slugByName[item.setName] || '',
    setName: item.setName || '',
    productId: String(Math.round(item.productId || 0)),
  }));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const query = (req.query.q as string || '').trim();
  const setFilter = req.query.set as string | undefined;

  if (!query || query.length < 2) {
    return res.status(200).json([]);
  }

  const setNames = setFilter && VALID_SETS[setFilter]
    ? [VALID_SETS[setFilter]]
    : [];

  try {
    const cards = await searchTcgPlayer(query, setNames);

    // Group by base name
    const groups: Record<string, CardGroup> = {};
    for (const card of cards) {
      const baseName = extractBaseName(card.name);
      if (!groups[baseName]) {
        groups[baseName] = { baseName, variants: [] };
      }
      groups[baseName].variants.push(card);
    }

    const results = Object.values(groups)
      .sort((a, b) => {
        const q = query.toLowerCase();
        const aStarts = a.baseName.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.baseName.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.baseName.length - b.baseName.length;
      })
      .slice(0, 20);

    // Cache search results at CDN edge for 10 min, revalidate in background
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    return res.status(200).json(results);
  } catch (error: any) {
    console.error('Search error:', error);
    return res.status(500).json({
      error: 'Search failed',
      message: error.message,
    });
  }
}
