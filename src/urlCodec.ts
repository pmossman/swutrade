import type { TradeCard, CardVariant, PriceMode } from './types';

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
