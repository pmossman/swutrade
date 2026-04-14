import type { CardVariant, PriceMode } from './types';
import type { WantsItem, VariantRestriction } from './persistence';
import { extractVariantLabel } from './variants';
import { getCardPrice } from './services/priceService';

/** True when a card's variant label satisfies the restriction. */
export function matchesRestriction(card: CardVariant, restriction: VariantRestriction): boolean {
  if (restriction.mode === 'any') return true;
  const label = extractVariantLabel(card.name);
  return restriction.variants.includes(label as (typeof restriction.variants)[number]);
}

/**
 * Pick the variant of the base card that best represents a wants item for
 * quick-add purposes. "Best" = cheapest variant that satisfies the
 * restriction. Returns null when no variant matches.
 */
export function bestMatchForWant(
  item: WantsItem,
  candidates: CardVariant[],
  priceMode: PriceMode,
): CardVariant | null {
  const matching = candidates.filter(c => matchesRestriction(c, item.restriction));
  if (matching.length === 0) return null;
  return matching.reduce((best, card) => {
    // Treat missing prices as Infinity so priced variants rank above
    // null-priced ones — otherwise an un-priced serialized card might
    // win the cheapest race unintentionally.
    const priceBest = getCardPrice(best, priceMode) ?? Infinity;
    const priceCard = getCardPrice(card, priceMode) ?? Infinity;
    return priceCard < priceBest ? card : best;
  });
}
