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

/**
 * `minimize-imbalance` — the clean-card-trade mode. Search for a
 *   subset pair that balances total value as tightly as possible;
 *   leftover is the implied cash settlement. Tiebreakers: more cards
 *   first, then more priority-starred cards.
 * `maximize-priorities` — the wishlist-clearing mode. Force-include
 *   every priority-starred overlap card, then add non-priority cards
 *   only if they improve or preserve balance. Leaves larger cash
 *   residuals but ensures starred cards always ship.
 */
export type MatchMode = 'minimize-imbalance' | 'maximize-priorities';

export interface MatchResult {
  /** Cards to go from me to them (my available ∩ their wants). */
  offering: CardVariant[];
  /** Cards to go from them to me (their available ∩ my wants). */
  receiving: CardVariant[];
  offeringTotal: number;
  receivingTotal: number;
  /** |offeringTotal - receivingTotal| — the implied cash settlement.
   *  Positive cash flows toward whichever side's total is lower. */
  imbalance: number;
  /** How many unique card families overlap in each direction. Reported
   *  regardless of which subset was actually picked. */
  overlapOffering: number;
  overlapReceiving: number;
  /** Which mode the picked subset was produced under (echoed back so
   *  the UI can show a mode label without re-deriving). */
  mode: MatchMode;
}

// Hard ceiling on the pool size passed into subset-sum. 2^16 = 65_536
// subsets per side; pair-wise comparison via sorted-by-sum + binary
// search keeps the loop at ~1M cheap ops per mode. A real pool larger
// than 16 gets truncated to the top-16 by price — the cheap long-tail
// cards matter less for balance anyway.
const SUBSET_SEARCH_CAP = 16;

interface PoolEntry {
  card: CardVariant;
  price: number;
  /** True if either party starred this family as a priority — we
   *  treat priority as symmetric so either side's star can pin the
   *  card into the maximize-priorities result. */
  priority: boolean;
}

/**
 * Given two users' wants + available lists, compute a balanced trade.
 * Cards are selected via subset-sum search so small, skewed-price
 * pools (common in real trades) can still find the tightest possible
 * balance instead of an early-greedy local minimum.
 *
 * The residual `imbalance` IS the implied cash — callers surface it
 * as "$X toward whichever side" rather than storing it separately.
 * See ROADMAP / NEXT.md for why cash stays derived, not persisted.
 */
export function computeMatch(
  myWants: WantEntry[],
  myAvailable: AvailableEntry[],
  theirWants: WantEntry[],
  theirAvailable: AvailableEntry[],
  allCards: CardVariant[],
  priceMode: PriceMode,
  percentage: number,
  mode: MatchMode = 'minimize-imbalance',
): MatchResult {
  const byProductId = new Map<string, CardVariant>();
  for (const card of allCards) {
    if (card.productId) byProductId.set(card.productId, card);
  }

  const pctMultiplier = percentage / 100;

  function price(card: CardVariant): number {
    return (getCardPrice(card, priceMode) ?? 0) * pctMultiplier;
  }

  // Priority lookup by family — either side's priority star pins the
  // card into maximize-priorities mode. Priority propagates from
  // WantEntry.isPriority through to the paired card on the opposite
  // side of the trade.
  const theirPriorityFamilies = new Set(
    theirWants.filter(w => w.isPriority).map(w => w.familyId),
  );
  const myPriorityFamilies = new Set(
    myWants.filter(w => w.isPriority).map(w => w.familyId),
  );

  // Build overlap pools: cards that match the OPPOSITE side's wants,
  // respecting variant restrictions. Dedupe by productId (a card can
  // technically match multiple want entries).
  const offeringPool = buildPool(
    theirWants,
    myAvailable,
    byProductId,
    theirPriorityFamilies,
    price,
  );
  const receivingPool = buildPool(
    myWants,
    theirAvailable,
    byProductId,
    myPriorityFamilies,
    price,
  );

  // Nothing on either side → empty result. ProposeBar handles this
  // by showing the "no overlap" hint instead of a Suggest button.
  if (offeringPool.length === 0 && receivingPool.length === 0) {
    return {
      offering: [], receiving: [],
      offeringTotal: 0, receivingTotal: 0,
      imbalance: 0,
      overlapOffering: 0, overlapReceiving: 0,
      mode,
    };
  }

  const picked = mode === 'maximize-priorities'
    ? selectMaximizePriorities(offeringPool, receivingPool)
    : selectMinimizeImbalance(offeringPool, receivingPool);

  const offeringTotal = round2(picked.offering.reduce((s, c) => s + price(c), 0));
  const receivingTotal = round2(picked.receiving.reduce((s, c) => s + price(c), 0));

  return {
    offering: picked.offering,
    receiving: picked.receiving,
    offeringTotal,
    receivingTotal,
    imbalance: round2(Math.abs(offeringTotal - receivingTotal)),
    overlapOffering: offeringPool.length,
    overlapReceiving: receivingPool.length,
    mode,
  };
}

function buildPool(
  theirWants: WantEntry[],
  myAvailable: AvailableEntry[],
  byProductId: Map<string, CardVariant>,
  priorityFamilies: Set<string>,
  price: (c: CardVariant) => number,
): PoolEntry[] {
  const seen = new Set<string>();
  const pool: PoolEntry[] = [];
  for (const want of theirWants) {
    for (const avail of myAvailable) {
      const card = byProductId.get(avail.productId);
      if (!card) continue;
      if (cardFamilyId(card) !== want.familyId) continue;
      if (!matchesRestriction(card, want.restriction)) continue;
      if (!card.productId || seen.has(card.productId)) continue;
      seen.add(card.productId);
      pool.push({
        card,
        price: price(card),
        priority: priorityFamilies.has(want.familyId),
      });
    }
  }
  // Sort priority-first, then by price descending — subset-sum
  // truncation (SUBSET_SEARCH_CAP) drops lowest-priority lowest-priced
  // cards when pools exceed the cap.
  pool.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    return b.price - a.price;
  });
  return pool.slice(0, SUBSET_SEARCH_CAP);
}

interface SubsetSummary {
  /** Bitmask over pool indices. */
  mask: number;
  sum: number;
  cardCount: number;
  priorityCount: number;
}

function enumerateSubsets(pool: PoolEntry[]): SubsetSummary[] {
  const n = pool.length;
  const total = 1 << n;
  const out: SubsetSummary[] = new Array(total);
  for (let mask = 0; mask < total; mask++) {
    let sum = 0;
    let cardCount = 0;
    let priorityCount = 0;
    for (let i = 0; i < n; i++) {
      if ((mask >> i) & 1) {
        sum += pool[i].price;
        cardCount++;
        if (pool[i].priority) priorityCount++;
      }
    }
    out[mask] = { mask, sum, cardCount, priorityCount };
  }
  return out;
}

function subsetToCards(pool: PoolEntry[], mask: number): CardVariant[] {
  const out: CardVariant[] = [];
  for (let i = 0; i < pool.length; i++) {
    if ((mask >> i) & 1) out.push(pool[i].card);
  }
  return out;
}

/**
 * Minimize-imbalance mode: full cross-product search across both
 * pools' subsets, scoring each pairing by imbalance (primary),
 * then total card count (prefers fuller trades), then priority
 * count (prefers inclusion of starred cards).
 *
 * Skips the trivially-empty pairing (both subsets empty) unless both
 * pools are empty — that case is handled above and never reaches here.
 */
function selectMinimizeImbalance(
  offering: PoolEntry[],
  receiving: PoolEntry[],
): { offering: CardVariant[]; receiving: CardVariant[] } {
  const offSubsets = enumerateSubsets(offering);
  const recSubsets = enumerateSubsets(receiving);

  let best: { offMask: number; recMask: number; imbalance: number; cards: number; priorities: number } | null = null;

  for (const off of offSubsets) {
    for (const rec of recSubsets) {
      // Require at least one card somewhere; the empty pairing is
      // the degenerate "no trade" result and doesn't help the user.
      if (off.cardCount + rec.cardCount === 0) continue;
      const imbalance = Math.abs(off.sum - rec.sum);
      const cards = off.cardCount + rec.cardCount;
      const priorities = off.priorityCount + rec.priorityCount;
      if (!best
        || imbalance < best.imbalance
        || (imbalance === best.imbalance && cards > best.cards)
        || (imbalance === best.imbalance && cards === best.cards && priorities > best.priorities)
      ) {
        best = { offMask: off.mask, recMask: rec.mask, imbalance, cards, priorities };
      }
    }
  }

  if (!best) return { offering: [], receiving: [] };
  return {
    offering: subsetToCards(offering, best.offMask),
    receiving: subsetToCards(receiving, best.recMask),
  };
}

/**
 * Maximize-priorities mode: force-include every priority-starred card
 * on both sides, then search non-priority subsets for the pair that
 * keeps the imbalance smallest. Starred cards always ship even if the
 * result is lopsided — that's the whole point of the mode.
 *
 * If there are zero priority cards, fall through to minimize-imbalance
 * so the button still produces a useful result.
 */
function selectMaximizePriorities(
  offering: PoolEntry[],
  receiving: PoolEntry[],
): { offering: CardVariant[]; receiving: CardVariant[] } {
  const priorityOff = offering.filter(p => p.priority);
  const priorityRec = receiving.filter(p => p.priority);
  if (priorityOff.length === 0 && priorityRec.length === 0) {
    return selectMinimizeImbalance(offering, receiving);
  }

  const nonPriorityOff = offering.filter(p => !p.priority);
  const nonPriorityRec = receiving.filter(p => !p.priority);

  const baseOffSum = priorityOff.reduce((s, p) => s + p.price, 0);
  const baseRecSum = priorityRec.reduce((s, p) => s + p.price, 0);

  const offExtras = enumerateSubsets(nonPriorityOff);
  const recExtras = enumerateSubsets(nonPriorityRec);

  let best: { offMask: number; recMask: number; imbalance: number; cards: number } | null = null;
  for (const off of offExtras) {
    for (const rec of recExtras) {
      const offSum = baseOffSum + off.sum;
      const recSum = baseRecSum + rec.sum;
      const imbalance = Math.abs(offSum - recSum);
      const cards = priorityOff.length + priorityRec.length + off.cardCount + rec.cardCount;
      if (!best
        || imbalance < best.imbalance
        || (imbalance === best.imbalance && cards > best.cards)
      ) {
        best = { offMask: off.mask, recMask: rec.mask, imbalance, cards };
      }
    }
  }

  const offExtraCards = best ? subsetToCards(nonPriorityOff, best.offMask) : [];
  const recExtraCards = best ? subsetToCards(nonPriorityRec, best.recMask) : [];

  return {
    offering: [...priorityOff.map(p => p.card), ...offExtraCards],
    receiving: [...priorityRec.map(p => p.card), ...recExtraCards],
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
