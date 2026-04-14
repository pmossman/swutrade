import type { TradeCard, CardVariant, PriceMode } from './types';
import type { WantsItem, AvailableItem, VariantRestriction } from './persistence';
import { CANONICAL_VARIANTS, type CanonicalVariant } from './variants';

export interface TradeUrlState {
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
}

export interface CardRef {
  productId: string;
  qty: number;
}

export interface PendingCards {
  yours: CardRef[];
  theirs: CardRef[];
}

export interface ParsedTradeUrl {
  pending: PendingCards;
  // null means "URL didn't specify — leave current (persisted) value alone"
  percentage: number | null;
  priceMode: PriceMode | null;
}

export function encodeCards(cards: TradeCard[]): string {
  return cards
    .filter(tc => tc.card.productId)
    .map(tc => `${tc.card.productId}.${tc.qty}`)
    .join(',');
}

export function decodeCardRefs(param: string): CardRef[] {
  if (!param) return [];
  return param.split(',').filter(Boolean).map(entry => {
    const [productId, qtyStr] = entry.split('.');
    return { productId, qty: parseInt(qtyStr, 10) || 1 };
  });
}

// When there's a trade, we always encode pm/pct so share links carry the
// sharer's intent rather than picking up the receiver's persisted prefs.
// When there's no trade, omit them so the bare URL stays clean and
// localStorage preferences remain authoritative.
export function buildTradeSearch(state: TradeUrlState): string {
  const params = new URLSearchParams();
  const y = encodeCards(state.yourCards);
  const t = encodeCards(state.theirCards);
  if (y) params.set('y', y);
  if (t) params.set('t', t);
  const hasTrade = Boolean(y || t);
  if (hasTrade || state.percentage !== 80) params.set('pct', String(state.percentage));
  if (hasTrade || state.priceMode !== 'market') {
    params.set('pm', state.priceMode === 'low' ? 'l' : 'm');
  }
  return params.toString();
}

/**
 * Parse a URL search string (without the leading `?`). Returns null when no
 * trade-relevant parameters are present.
 */
export function parseTradeUrl(search: string): ParsedTradeUrl | null {
  const params = new URLSearchParams(search);
  const y = params.get('y');
  const t = params.get('t');
  const pct = params.get('pct');
  const pm = params.get('pm');

  if (!y && !t && !pct && !pm) return null;

  return {
    pending: {
      yours: decodeCardRefs(y || ''),
      theirs: decodeCardRefs(t || ''),
    },
    percentage: pct ? parseInt(pct, 10) || 80 : null,
    priceMode: pm === 'l' ? 'low' : pm === 'm' ? 'market' : null,
  };
}

export function resolveCards(
  refs: CardRef[],
  cardMap: Map<string, CardVariant>,
): TradeCard[] {
  const resolved: TradeCard[] = [];
  for (const ref of refs) {
    const card = cardMap.get(ref.productId);
    if (card) resolved.push({ card, qty: ref.qty });
  }
  return resolved;
}

export function buildCardMap(cards: CardVariant[]): Map<string, CardVariant> {
  const map = new Map<string, CardVariant>();
  for (const card of cards) {
    if (card.productId) map.set(card.productId, card);
  }
  return map;
}

// =====================================================================
// List-sharing codec (Phase 1 → consumed in Phase 3)
// =====================================================================
//
// URL grammar:
//   w=<want>[,<want>...]    each want is `<encoded_familyId>.<qty>[.r<hex>][.p]`
//   a=<avail>[,<avail>...]  each available is `<productId>.<qty>`
//
// For wants:
//   - familyId is URL-encoded (handles "::" and slashes safely)
//   - .r<hex> appears only when restriction.mode === 'restricted'; the
//     hex is a bitmask over CANONICAL_VARIANTS (Standard=bit0 … Showcase=bit7)
//   - .p appears only when isPriority is true
//
// Decoder caps qty at [1, 99] and silently drops malformed entries so
// a partly-broken URL still loads what it can.
// =====================================================================

/** Convert a list of canonical variants into a bitmask over CANONICAL_VARIANTS. */
export function variantsToMask(variants: readonly CanonicalVariant[]): number {
  let mask = 0;
  for (const v of variants) {
    const idx = CANONICAL_VARIANTS.indexOf(v);
    if (idx >= 0) mask |= 1 << idx;
  }
  return mask;
}

export function maskToVariants(mask: number): CanonicalVariant[] {
  const out: CanonicalVariant[] = [];
  for (let i = 0; i < CANONICAL_VARIANTS.length; i++) {
    if (mask & (1 << i)) out.push(CANONICAL_VARIANTS[i]);
  }
  return out;
}

export type WantsUrlEntry = Pick<WantsItem, 'familyId' | 'qty' | 'restriction' | 'isPriority'>;
export type AvailableUrlEntry = Pick<AvailableItem, 'productId' | 'qty'>;

export function encodeWants(items: readonly WantsUrlEntry[]): string {
  return items.map(w => {
    const parts = [encodeURIComponent(w.familyId), String(clampQty(w.qty))];
    if (w.restriction.mode === 'restricted' && w.restriction.variants.length > 0) {
      parts.push('r' + variantsToMask(w.restriction.variants).toString(16));
    }
    if (w.isPriority) parts.push('p');
    return parts.join('.');
  }).join(',');
}

export function decodeWants(param: string): WantsUrlEntry[] {
  if (!param) return [];
  const out: WantsUrlEntry[] = [];
  for (const entry of param.split(',').filter(Boolean)) {
    const fields = entry.split('.');
    if (fields.length < 2) continue;
    const [encId, qtyStr, ...flags] = fields;
    let familyId: string;
    try {
      familyId = decodeURIComponent(encId);
    } catch {
      continue;
    }
    if (!familyId) continue;
    const qty = clampQty(parseInt(qtyStr, 10));
    let restriction: VariantRestriction = { mode: 'any' };
    let isPriority: true | undefined;
    for (const flag of flags) {
      if (flag === 'p') isPriority = true;
      else if (flag.startsWith('r')) {
        const mask = parseInt(flag.slice(1), 16);
        if (Number.isFinite(mask)) {
          const variants = maskToVariants(mask);
          if (variants.length > 0) restriction = { mode: 'restricted', variants };
        }
      }
    }
    out.push({ familyId, qty, restriction, ...(isPriority ? { isPriority } : {}) });
  }
  return out;
}

export function encodeAvailable(items: readonly AvailableUrlEntry[]): string {
  return items.map(a => `${a.productId}.${clampQty(a.qty)}`).join(',');
}

export function decodeAvailable(param: string): AvailableUrlEntry[] {
  if (!param) return [];
  const out: AvailableUrlEntry[] = [];
  for (const entry of param.split(',').filter(Boolean)) {
    const [productId, qtyStr] = entry.split('.');
    if (!productId) continue;
    out.push({ productId, qty: clampQty(parseInt(qtyStr, 10)) });
  }
  return out;
}

function clampQty(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 99) return 99;
  return Math.floor(n);
}
