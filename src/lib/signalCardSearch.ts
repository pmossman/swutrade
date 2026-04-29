/**
 * Client-side family-level card search for the Signal Builder view.
 *
 * Mirrors `autocompleteSignalFamilies` from `lib/signalMatching.ts`
 * (which runs server-side for the now-removed Discord slash) but
 * works against the React app's already-loaded `allLoadedCards`
 * catalog so there's no network round-trip per keystroke.
 *
 * Output is name-deduped: "Luke Skywalker - Faithful Friend" maps
 * to ONE entry covering all reprints (Spark of Rebellion + 4
 * promo printings), with the canonical family picked by a
 * "prefer non-secondary set" heuristic.
 */

import type { CardVariant } from '../types';
import { nameSlug } from '../enrichment';

const SECONDARY_SET_PATTERNS = [
  'promo', 'exclusive', 'intro-battle', 'gift-box', 'weekly-play',
];
function isSecondaryFamily(familyId: string): boolean {
  return SECONDARY_SET_PATTERNS.some(p => familyId.includes(p));
}

function familyIdFor(card: CardVariant): string {
  // Same shape used by `enrich-cards.ts`'s familyIndex keys:
  // `<set-slug>::<name-slug>`. Slug derived from displayName so
  // variant suffixes don't fragment the family.
  const display = card.displayName ?? card.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return `${card.set}::${nameSlug(display)}`;
}

export interface SignalSearchResult {
  /** Canonical familyId (the slash + API contract). */
  familyId: string;
  /** Display name (variant suffix stripped). */
  name: string;
  /** Set code, e.g. "JTL", "SOR". */
  setCode: string;
  /** Variants on this family, sorted cheapest-first. */
  variants: Array<{ productId: string; variant: string; market: number | null }>;
  /** Card type (Leader / Unit / Event / Upgrade / Base / etc).
   *  Optional — promo sets that didn't enrich don't carry it. */
  cardType?: string;
  /** N additional families that share this display name (promo
   *  reprints). 0 when the card is set-unique. */
  alternateCount: number;
  /** Set name (for set selector display). */
  setName: string;
}

/**
 * Build a name → primary-family map once per `allCards` ref. The
 * caller passes the same array across keystrokes, so memoizing on
 * the array reference avoids re-grouping per query.
 */
function buildNameIndex(allCards: CardVariant[]): Map<string, SignalSearchResult> {
  // First pass: group all cards by displayName.
  const byName = new Map<string, CardVariant[]>();
  for (const c of allCards) {
    const display = c.displayName ?? c.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const list = byName.get(display) ?? [];
    list.push(c);
    byName.set(display, list);
  }

  // Second pass: collapse to one entry per name. Group cards by
  // family within the name; pick a primary family; collect its
  // variants.
  const out = new Map<string, SignalSearchResult>();
  for (const [name, cards] of byName) {
    const byFamily = new Map<string, CardVariant[]>();
    for (const c of cards) {
      const fid = familyIdFor(c);
      const list = byFamily.get(fid) ?? [];
      list.push(c);
      byFamily.set(fid, list);
    }
    const familyIds = Array.from(byFamily.keys()).sort();
    const primary = familyIds.find(id => !isSecondaryFamily(id)) ?? familyIds[0];
    const primaryCards = byFamily.get(primary)!;
    const variants = primaryCards
      .map(c => ({
        productId: c.productId ?? '',
        variant: c.variant ?? 'Standard',
        market: c.marketPrice ?? null,
      }))
      .filter(v => v.productId.length > 0)
      .sort((a, b) => (a.market ?? Infinity) - (b.market ?? Infinity));
    if (variants.length === 0) continue;
    const cardType = primaryCards.find(c => c.cardType)?.cardType;
    out.set(name, {
      familyId: primary,
      name,
      setCode: deriveSetCode(primary),
      variants,
      cardType,
      alternateCount: familyIds.length - 1,
      setName: primaryCards[0].setName ?? primaryCards[0].set,
    });
  }
  return out;
}

/**
 * Slug → 3-4 letter set code. Hardcoded short list rather than
 * importing `SETS` to keep this module's dependency footprint
 * minimal — these are stable across a card pool generation.
 */
function deriveSetCode(familyId: string): string {
  const slug = familyId.split('::')[0];
  switch (slug) {
    case 'spark-of-rebellion':           return 'SOR';
    case 'shadows-of-the-galaxy':        return 'SHD';
    case 'twilight-of-the-republic':     return 'TWI';
    case 'jump-to-lightspeed':           return 'JTL';
    case 'secrets-of-power':             return 'SEC';
    case 'legends-of-the-force':         return 'LOF';
    case 'a-lawless-time':               return 'LAW';
    case 'twin-suns':                    return 'TS';
    case 'ashes-of-the-empire':          return 'ATE';
    case 'intro-battle-hoth':            return 'IBH';
    case 'judge-promos':                 return 'JP';
    case 'organized-play-promos':        return 'OPP';
    case 'sector-and-regional-promos-season-1': return 'SRP';
    case 'event-exclusive-promos':       return 'EEP';
    case 'gamegenic-promos':             return 'GGP';
    case 'prerelease-promos':            return 'PRP';
    case '2024-convention-exclusive':    return 'C24';
    case '2025-convention-exclusive':    return 'C25';
    case '2025-gift-box':                return 'G25';
    default:
      // Weekly-play promos: take parent code + W.
      if (slug.endsWith('-weekly-play-promos')) {
        const parent = deriveSetCode(slug.replace('-weekly-play-promos', '::x'));
        return parent + 'W';
      }
      return slug.slice(0, 4).toUpperCase();
  }
}

let cachedAllCards: CardVariant[] | null = null;
let cachedIndex: Map<string, SignalSearchResult> | null = null;

/**
 * Search families by name with starts-with priority then
 * substring. Empty query returns []. `allCards` is expected to be
 * stable across calls (memoized at the React level); we cache the
 * dedup index between searches to keep the per-keystroke cost
 * sub-millisecond.
 */
export function searchSignalFamilies(
  allCards: CardVariant[],
  query: string,
  limit = 25,
): SignalSearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  if (cachedAllCards !== allCards || cachedIndex === null) {
    cachedIndex = buildNameIndex(allCards);
    cachedAllCards = allCards;
  }
  const startsWith: SignalSearchResult[] = [];
  const contains: SignalSearchResult[] = [];
  for (const result of cachedIndex.values()) {
    const lower = result.name.toLowerCase();
    if (lower.startsWith(q)) startsWith.push(result);
    else if (lower.includes(q)) contains.push(result);
    if (startsWith.length + contains.length >= limit * 2) break;
  }
  return [...startsWith, ...contains].slice(0, limit);
}

/**
 * Resolve a familyId back to a SignalSearchResult — used by the
 * builder when displaying a card the user already added (so we
 * can show its variants + thumbnail + setCode without re-search).
 */
export function lookupFamilyClient(
  allCards: CardVariant[],
  familyId: string,
): SignalSearchResult | null {
  if (cachedAllCards !== allCards || cachedIndex === null) {
    cachedIndex = buildNameIndex(allCards);
    cachedAllCards = allCards;
  }
  for (const result of cachedIndex.values()) {
    if (result.familyId === familyId) return result;
  }
  return null;
}
