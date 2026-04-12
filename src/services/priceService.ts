import type { CardVariant, CardGroup, SetInfo } from '../types';

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

export function cardImageUrl(productId: string | undefined, size: 'sm' | 'md' | 'lg' = 'sm'): string | null {
  if (!productId || productId === '0') return null;
  const dims = size === 'lg' ? '400x558' : size === 'md' ? '200x279' : '200x279';
  return `https://product-images.tcgplayer.com/fit-in/${dims}/${productId}.jpg`;
}

export function cardTcgPlayerUrl(productId: string | undefined): string | null {
  if (!productId || productId === '0') return null;
  return `https://www.tcgplayer.com/product/${productId}`;
}
