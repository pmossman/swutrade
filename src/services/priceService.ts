import type { CardVariant, CardGroup, SetInfo, PriceMode, TradeCard } from '../types';

// Static data is served from /data/ (built at deploy time)
const DATA_BASE = '/data';

// In-memory client-side cache (persists across navigation within the tab)
const clientCache: Record<string, CardVariant[]> = {};

interface Manifest {
  timestamp: string;
  sets: Record<string, { cards: number }>;
}

let manifestCache: Manifest | null = null;

export async function fetchManifest(): Promise<Manifest> {
  if (manifestCache) return manifestCache;
  const res = await fetch(`${DATA_BASE}/manifest.json`);
  if (!res.ok) throw new Error('Failed to load manifest');
  manifestCache = await res.json();
  return manifestCache!;
}

export async function fetchSetPrices(set: SetInfo): Promise<CardVariant[]> {
  if (clientCache[set.slug]) return clientCache[set.slug];

  const res = await fetch(`${DATA_BASE}/${set.slug}.json`);
  if (!res.ok) {
    throw new Error(`Failed to fetch prices for ${set.name}: ${res.statusText}`);
  }

  const data: CardVariant[] = await res.json();
  clientCache[set.slug] = data;
  return data;
}

export function extractVariantLabel(name: string): string {
  const match = name.match(/\(([^)]+)\)\s*$/);
  if (!match) return 'Standard';
  return match[1];
}

// Leaders (and Base cards) in SWU are the only cards that get Showcase
// variants printed, so the presence of any Showcase variant in a card's
// variant list is a reliable signal that the base card is landscape-
// oriented. Set-by-set leader counts vary, so number ranges aren't a
// reliable proxy.
export function isLeaderOrBaseGroup(variants: { name: string }[]): boolean {
  return variants.some(v => extractVariantLabel(v.name) === 'Showcase');
}

export function extractBaseName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function groupCards(cards: CardVariant[]): CardGroup[] {
  const groups: Record<string, CardGroup> = {};

  for (const card of cards) {
    const baseName = extractBaseName(card.name);
    if (!groups[baseName]) {
      groups[baseName] = { baseName, variants: [] };
    }
    groups[baseName].variants.push(card);
  }

  return Object.values(groups);
}

export function adjustPrice(price: number | null, percentage: number): number | null {
  if (price === null) return null;
  return Math.round(price * (percentage / 100) * 100) / 100;
}

/** Get the active price for a card based on the price mode */
export function getCardPrice(card: CardVariant, mode: PriceMode): number | null {
  return mode === 'low' ? card.lowPrice : card.marketPrice;
}

/** Get the alternate (non-active) price for a card */
export function getAltPrice(card: CardVariant, mode: PriceMode): number | null {
  return mode === 'low' ? card.marketPrice : card.lowPrice;
}

/**
 * Count how many cards on a side have no price for the active mode. Used to
 * flag trades whose totals may be misleading because some line items are
 * silently treated as $0.
 */
export function countMissingPrices(cards: TradeCard[], mode: PriceMode): number {
  let n = 0;
  for (const tc of cards) {
    if (getCardPrice(tc.card, mode) === null) n += tc.qty;
  }
  return n;
}

export function cardImageUrl(productId: string | undefined, size: 'sm' | 'md' | 'lg' = 'sm'): string | null {
  if (!productId || productId === '0') return null;
  const dims = size === 'lg' ? '400x558' : size === 'md' ? '200x279' : '200x279';
  return `https://product-images.tcgplayer.com/fit-in/${dims}/${productId}.jpg`;
}

export function cardTcgPlayerUrl(productId: string | undefined): string | null {
  if (!productId || productId === '0') return null;
  return `https://www.tcgplayer.com/product/${productId}`;
}
