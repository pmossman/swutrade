/*
 * Card-catalog loaders. v1 serves the catalog as static JSON out of
 * /data/*.json; v2 reuses those files via a symlink
 * (app-v2/public/data -> ../../public/data). One source of truth for
 * card data; v1's refresh pipeline (scripts/fetch-prices.ts + the
 * GitHub Actions deploy-hook cron) continues to own updates.
 *
 * v1's catalog is public, unauthenticated, and cheap to fetch — no
 * need to go through /api/*. Fetched with React Query and cached
 * aggressively (staleTime: Infinity during the tab's lifetime).
 */

export interface ProductIndexEntry {
  /** Card display name (no set appended). */
  n: string;
  /** Market price in USD, or null. */
  p: number | null;
  /** Low price in USD, or null. */
  l: number | null;
  /** Set display name. */
  s: string;
}

export type ProductIndex = Record<string, ProductIndexEntry>;

export interface FamilyVariantEntry {
  /** productId */
  p: string;
  /** canonical variant label ("Standard", "Hyperspace", "Foil", etc.) */
  v: string;
  /** market price */
  m: number | null;
  /** low price */
  l: number | null;
  /** display name */
  n: string;
}

export type FamilyIndex = Record<string, FamilyVariantEntry[]>;

export interface SetCard {
  productId: string;
  name: string;
  variant: string;
  marketPrice: number | null;
  lowPrice: number | null;
  set: string;
  setName: string;
}

export async function fetchProductIndex(): Promise<ProductIndex> {
  const res = await fetch('/data/product-index.json');
  if (!res.ok) throw new Error(`product-index.json: ${res.status}`);
  return (await res.json()) as ProductIndex;
}

export async function fetchFamilyIndex(): Promise<FamilyIndex> {
  const res = await fetch('/data/family-index.json');
  if (!res.ok) throw new Error(`family-index.json: ${res.status}`);
  return (await res.json()) as FamilyIndex;
}

/**
 * Cross-printing family id. Mirrors v1's `cardFamilyId` helper:
 * strip the trailing `(variant)` suffix from the TCGPlayer product
 * name, kebab-case it, prefix with the set slug. A wishlist entry
 * keyed on this key matches any printing of the card.
 */
export function cardFamilyId(card: Pick<SetCard, 'set' | 'name'>): string {
  const baseName = card.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const slug = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${card.set}::${slug}`;
}

export async function fetchSet(slug: string): Promise<SetCard[]> {
  const res = await fetch(`/data/${slug}.json`);
  if (!res.ok) throw new Error(`${slug}.json: ${res.status}`);
  const raw = (await res.json()) as Array<{
    productId?: string;
    name: string;
    variant: string;
    marketPrice: number | null;
    lowPrice: number | null;
    set: string;
    setName: string;
  }>;
  return raw
    .filter((c): c is SetCard & { productId: string } => !!c.productId)
    .map((c) => ({
      productId: c.productId,
      name: c.name,
      variant: c.variant,
      marketPrice: c.marketPrice,
      lowPrice: c.lowPrice,
      set: c.set,
      setName: c.setName,
    }));
}
