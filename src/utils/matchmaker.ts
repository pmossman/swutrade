import type { CardVariant, PriceMode } from '../types';
import type { VariantRestriction } from '../persistence';
import { getCardPrice } from '../services/priceService';
import { matchesRestriction } from '../listMatching';
import { cardFamilyId } from '../variants';

interface WantEntry {
  familyId: string;
  qty: number;
  restriction: VariantRestriction;
  isPriority?: boolean;
}

interface AvailableEntry {
  productId: string;
  qty: number;
}

export interface MatchResult {
  /** Cards to go from me to them (my available ∩ their wants). */
  offering: CardVariant[];
  /** Cards to go from them to me (their available ∩ my wants). */
  receiving: CardVariant[];
  offeringTotal: number;
  receivingTotal: number;
  /** How many unique card families overlap in each direction. */
  overlapOffering: number;
  overlapReceiving: number;
}

/**
 * Given two users' wants + available lists, compute the fairest
 * balanced trade. Returns cards to populate both sides of the trade
 * view.
 *
 * Algorithm:
 *   1. Build overlap pools:
 *      - offering = cards I have that they want
 *      - receiving = cards they have that I want
 *   2. Sort each pool by unit price descending (big-ticket cards
 *      first so the balancing has more granularity).
 *   3. Greedily pull from the LESS-valued side until adding another
 *      card would overshoot the target balance, then switch sides.
 *   4. Stop when both sides are within the tolerance or pools are
 *      exhausted.
 *
 * This is intentionally simple — for 10-50 card overlaps, greedy
 * produces near-optimal results and runs in microseconds.
 */
export function computeMatch(
  myWants: WantEntry[],
  myAvailable: AvailableEntry[],
  theirWants: WantEntry[],
  theirAvailable: AvailableEntry[],
  allCards: CardVariant[],
  priceMode: PriceMode,
  percentage: number,
): MatchResult {
  const byFamilyAll = new Map<string, CardVariant[]>();
  const byProductId = new Map<string, CardVariant>();
  for (const card of allCards) {
    if (card.productId) byProductId.set(card.productId, card);
    const fid = cardFamilyId(card);
    const bucket = byFamilyAll.get(fid);
    if (bucket) bucket.push(card);
    else byFamilyAll.set(fid, [card]);
  }

  const pctMultiplier = percentage / 100;

  function price(card: CardVariant): number {
    return (getCardPrice(card, priceMode) ?? 0) * pctMultiplier;
  }

  // Build offering pool: my available cards that satisfy their wants.
  const offeringPool: CardVariant[] = [];
  for (const want of theirWants) {

    // Find the specific variant I have available that matches their restriction.
    for (const avail of myAvailable) {
      const card = byProductId.get(avail.productId);
      if (!card) continue;
      if (cardFamilyId(card) !== want.familyId) continue;
      if (!matchesRestriction(card, want.restriction)) continue;
      offeringPool.push(card);
    }
  }

  // Build receiving pool: their available cards that satisfy my wants.
  const receivingPool: CardVariant[] = [];
  for (const want of myWants) {

    for (const avail of theirAvailable) {
      const card = byProductId.get(avail.productId);
      if (!card) continue;
      if (cardFamilyId(card) !== want.familyId) continue;
      if (!matchesRestriction(card, want.restriction)) continue;
      receivingPool.push(card);
    }
  }

  // Dedupe by productId (a card might match multiple wants).
  const dedup = (pool: CardVariant[]) => {
    const seen = new Set<string>();
    return pool.filter(c => {
      if (!c.productId || seen.has(c.productId)) return false;
      seen.add(c.productId);
      return true;
    });
  };
  const offering = dedup(offeringPool).sort((a, b) => price(b) - price(a));
  const receiving = dedup(receivingPool).sort((a, b) => price(b) - price(a));

  // Greedy balancing: alternate pulling from the less-valued side.
  const picked: { offering: CardVariant[]; receiving: CardVariant[] } = {
    offering: [],
    receiving: [],
  };
  let totalOffer = 0;
  let totalReceive = 0;
  let oi = 0;
  let ri = 0;

  while (oi < offering.length || ri < receiving.length) {
    // Pull from whichever side is behind (or from whichever has cards left).
    if (totalOffer <= totalReceive && oi < offering.length) {
      const card = offering[oi++];
      picked.offering.push(card);
      totalOffer += price(card);
    } else if (ri < receiving.length) {
      const card = receiving[ri++];
      picked.receiving.push(card);
      totalReceive += price(card);
    } else if (oi < offering.length) {
      const card = offering[oi++];
      picked.offering.push(card);
      totalOffer += price(card);
    } else {
      break;
    }

    // If both sides have at least one card and we're roughly balanced,
    // stop before we overshoot. "Roughly balanced" = within 20% of the
    // larger side, or within $1 absolute.
    if (picked.offering.length > 0 && picked.receiving.length > 0) {
      const diff = Math.abs(totalOffer - totalReceive);
      const max = Math.max(totalOffer, totalReceive);
      if (diff < 1 || (max > 0 && diff / max < 0.2)) {
        // Check if adding the next card from either side would make it worse.
        const nextOffer = oi < offering.length ? price(offering[oi]) : Infinity;
        const nextReceive = ri < receiving.length ? price(receiving[ri]) : Infinity;
        if (nextOffer > diff && nextReceive > diff) break;
      }
    }
  }

  return {
    offering: picked.offering,
    receiving: picked.receiving,
    offeringTotal: Math.round(totalOffer * 100) / 100,
    receivingTotal: Math.round(totalReceive * 100) / 100,
    overlapOffering: offering.length,
    overlapReceiving: receiving.length,
  };
}
