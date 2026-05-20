import type { CardVariant, PriceMode } from '../../types';
import { CANONICAL_VARIANTS, cardFamilyId, extractVariantLabel } from '../../variants';
import { getCardPrice } from '../../services/priceService';
import { MAIN_GROUP, SPECIAL_GROUP } from '../../applySelectionFilters';
import { SETS } from '../../types';

/**
 * Pure helpers for the shared ListToolbar — filter + sort logic
 * factored out of the component so it's exercised by unit tests
 * without rendering. Mirrors the contract the picker's
 * `applySelectionFilters` establishes: vocabulary (set / variant)
 * is identical so users don't context-switch between the picker's
 * filter chips and a list view's.
 */

export type ListSortMode =
  | 'default'      // priority-first then newest (wishlist); newest (binder)
  | 'newest'
  | 'oldest'
  | 'price-desc'
  | 'price-asc'
  | 'name-asc'
  | 'name-desc';

export const LIST_SORT_MODES: readonly ListSortMode[] = [
  'default',
  'newest',
  'oldest',
  'price-desc',
  'price-asc',
  'name-asc',
  'name-desc',
] as const;

export interface ListFilters {
  /** Free-text search against card displayName (case-insensitive substring). */
  query: string;
  /** Set slugs (supports MAIN_GROUP / SPECIAL_GROUP pseudo-slugs the
   *  picker also accepts — keeps the chip vocabulary identical). */
  selectedSets: readonly string[];
  /** Canonical variant labels (e.g. ['Hyperspace', 'Hyperspace Foil']). */
  selectedVariants: readonly string[];
  /** Wishlist-only: only show isPriority rows. */
  priorityOnly?: boolean;
  /** Profile-only: only show rows the host pre-flagged as matching the
   *  viewer's other list (via the canonical matchesRestriction
   *  predicate — see CommunityView.tsx::enrichMember for the reference
   *  implementation). */
  matchOnly?: boolean;
}

export const DEFAULT_LIST_FILTERS: ListFilters = {
  query: '',
  selectedSets: [],
  selectedVariants: [],
  priorityOnly: false,
  matchOnly: false,
};

export interface ListRowMeta {
  /** Resolved card; may be null if the catalog hasn't loaded yet. When
   *  null, any filter that needs card data short-circuits the row out
   *  (so a partial-load state doesn't accidentally surface rows under
   *  filters that can't validate them). */
  card: CardVariant | null;
  /** Sort key for newest/oldest. */
  addedAt: number;
  /** Canonical variants this row represents. For an AvailableItem this
   *  is its single concrete variant; for a WantsItem with
   *  restriction.any this is every CANONICAL_VARIANT; for a
   *  restriction.restricted Want it's the restricted list. The
   *  variant filter passes whenever any of `selectedVariants` is in
   *  `variantTags` (or `selectedVariants` is empty). */
  variantTags: readonly string[];
  isPriority?: boolean;
  isMatch?: boolean;
}

const MAIN_SLUGS = new Set(SETS.filter(s => s.category === 'main').map(s => s.slug));
const SPECIAL_SLUGS = new Set(SETS.filter(s => s.category === 'promo').map(s => s.slug));

/** Slug → recency index. SETS lists oldest-first (SOR at index 0,
 *  LAW newest among main sets at index 6); the index value IS the
 *  recency — higher = newer. Unknown sets default to -1 → sink to
 *  the bottom of any set-ordered list. */
const SET_RECENCY: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < SETS.length; i++) {
    m.set(SETS[i].slug, i);
  }
  return m;
})();

/** Canonical SWU aspect order — light-side pairings first, then dark
 *  side, then neutral. Cards with multiple aspects sort by their
 *  primary (first-listed) aspect; cards with no aspect (mostly
 *  bases) sink to the bottom of each set group. */
const ASPECT_ORDER: Record<string, number> = {
  Heroism: 0,
  Vigilance: 1,
  Command: 2,
  Cunning: 3,
  Aggression: 4,
  Villainy: 5,
};

function aspectIndex(card: CardVariant | null): number {
  if (!card) return 999;
  const primary = card.aspects?.[0];
  if (!primary) return 100; // bases / aspectless — between aspects and unknown
  return ASPECT_ORDER[primary] ?? 50;
}

function setRecency(card: CardVariant | null): number {
  if (!card) return -1;
  return SET_RECENCY.get(card.set) ?? -1;
}

function cardNumber(card: CardVariant | null): number {
  if (!card) return Number.POSITIVE_INFINITY;
  // `card.number` is a string like "001", "078", or "101/264"
  // (Standard prints carry the "/total" denominator while
  // Hyperspace + Foil variants ship without it). `parseInt` stops
  // at the first non-digit so both forms reduce cleanly.
  const n = parseInt(card.number, 10);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

const VARIANT_ORDER_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < CANONICAL_VARIANTS.length; i++) {
    m[CANONICAL_VARIANTS[i]] = i;
  }
  return m;
})();

/** Variant rank within a card family — Standard first, then the
 *  rest of CANONICAL_VARIANTS in their canonical order. Wants rows
 *  store the full variantTags array; we use the LOWEST index across
 *  the tags so a `restriction.any` row sorts as if it were the
 *  Standard print (matching where users see the canonical art). */
function variantRank(row: ListRowMeta): number {
  if (row.variantTags.length === 0) return CANONICAL_VARIANTS.length;
  let best: number = CANONICAL_VARIANTS.length;
  for (const tag of row.variantTags) {
    const idx = VARIANT_ORDER_INDEX[tag];
    if (idx !== undefined && idx < best) best = idx;
  }
  return best;
}

function buildSetMatcher(selected: readonly string[]): ((slug: string) => boolean) | null {
  if (selected.length === 0) return null;
  const exact = new Set<string>();
  let includeMain = false;
  let includeSpecial = false;
  for (const entry of selected) {
    if (entry === MAIN_GROUP) includeMain = true;
    else if (entry === SPECIAL_GROUP) includeSpecial = true;
    else exact.add(entry);
  }
  return (slug: string) =>
    exact.has(slug)
    || (includeMain && MAIN_SLUGS.has(slug))
    || (includeSpecial && SPECIAL_SLUGS.has(slug));
}

function rowDisplayName(card: CardVariant): string {
  return (card.displayName ?? card.name).toLowerCase();
}

function priceForSort(card: CardVariant | null, mode: PriceMode): number {
  if (!card) return -Infinity;
  const p = getCardPrice(card, mode);
  return p ?? -Infinity;
}

/** Default-sort context built once per `applyListToolbar` call so
 *  the comparator can ask "what's the primary card number for this
 *  family?" without a per-comparison map lookup. The primary number
 *  is the lowest cleanly-parseable number across every row that
 *  shares the family — Lawbringer Standard's "101/264" → 101 wins
 *  over Lawbringer Hyperspace's "365" → 365, so both variants sit
 *  in position 101 of the set block. */
interface DefaultSortCtx {
  familyPrimaryNumber: Map<string, number>;
}

function buildDefaultSortCtx<TRow extends ListRowMeta>(rows: readonly TRow[]): DefaultSortCtx {
  const familyPrimaryNumber = new Map<string, number>();
  for (const row of rows) {
    if (!row.card) continue;
    const fid = cardFamilyId(row.card);
    const n = cardNumber(row.card);
    const prev = familyPrimaryNumber.get(fid);
    if (prev === undefined || n < prev) familyPrimaryNumber.set(fid, n);
  }
  return { familyPrimaryNumber };
}

function familyKey(row: ListRowMeta, ctx: DefaultSortCtx): { primaryNumber: number; familyId: string } {
  if (!row.card) {
    return { primaryNumber: Number.POSITIVE_INFINITY, familyId: '' };
  }
  const familyId = cardFamilyId(row.card);
  return {
    primaryNumber: ctx.familyPrimaryNumber.get(familyId) ?? cardNumber(row.card),
    familyId,
  };
}

function cmpDefault<TRow extends ListRowMeta>(a: TRow, b: TRow, ctx: DefaultSortCtx): number {
  // Tiered default sort:
  //   1. Priority first (wishlist-only — binder rows never set
  //      isPriority).
  //   2. Set, newest first. Real users think of their collection in
  //      set blocks ("my LAW cards", "old SOR stuff").
  //   3. Aspect, canonical order. Same-color cards group visually.
  //   4. Family-primary number ascending. The family's *Standard*
  //      print number is the canonical position; variants (Foil,
  //      Hyperspace, etc.) pool at that same position so two prints
  //      of the same card sit next to each other instead of being
  //      separated by the 264-card-set gap that Hyperspace
  //      numbering imposes.
  //   5. Family id alphabetical (tie-breaks two different families
  //      that happen to share a primary number — rare, but
  //      deterministic).
  //   6. Variant rank within family — Standard first, then
  //      Hyperspace, Foil, etc. per CANONICAL_VARIANTS order.
  //   7. addedAt as a stable tie-breaker.
  const pa = a.isPriority ? 1 : 0;
  const pb = b.isPriority ? 1 : 0;
  if (pa !== pb) return pb - pa;

  const sa = setRecency(a.card);
  const sb = setRecency(b.card);
  if (sa !== sb) return sb - sa;

  const ia = aspectIndex(a.card);
  const ib = aspectIndex(b.card);
  if (ia !== ib) return ia - ib;

  const fka = familyKey(a, ctx);
  const fkb = familyKey(b, ctx);
  if (fka.primaryNumber !== fkb.primaryNumber) {
    return fka.primaryNumber - fkb.primaryNumber;
  }
  if (fka.familyId !== fkb.familyId) {
    return fka.familyId < fkb.familyId ? -1 : 1;
  }

  const va = variantRank(a);
  const vb = variantRank(b);
  if (va !== vb) return va - vb;

  return a.addedAt - b.addedAt;
}

function cmpByMode<TRow extends ListRowMeta>(
  a: TRow,
  b: TRow,
  sort: ListSortMode,
  priceMode: PriceMode,
  defaultCtx: DefaultSortCtx,
): number {
  switch (sort) {
    case 'default':
      return cmpDefault(a, b, defaultCtx);
    case 'newest':
      return b.addedAt - a.addedAt;
    case 'oldest':
      return a.addedAt - b.addedAt;
    case 'price-desc':
      return priceForSort(b.card, priceMode) - priceForSort(a.card, priceMode);
    case 'price-asc': {
      // Cards with no price sink to the bottom in BOTH price sorts
      // (instead of floating to the top under asc). Otherwise a
      // user sorting by price-asc would see "unknown price" rows
      // before the cheapest real card, which doesn't match intent.
      const pa = priceForSort(a.card, priceMode);
      const pb = priceForSort(b.card, priceMode);
      if (pa === -Infinity && pb === -Infinity) return 0;
      if (pa === -Infinity) return 1;
      if (pb === -Infinity) return -1;
      return pa - pb;
    }
    case 'name-asc': {
      const na = a.card ? rowDisplayName(a.card) : '';
      const nb = b.card ? rowDisplayName(b.card) : '';
      if (!na && !nb) return 0;
      if (!na) return 1;
      if (!nb) return -1;
      return na.localeCompare(nb);
    }
    case 'name-desc': {
      const na = a.card ? rowDisplayName(a.card) : '';
      const nb = b.card ? rowDisplayName(b.card) : '';
      if (!na && !nb) return 0;
      if (!na) return 1;
      if (!nb) return -1;
      return nb.localeCompare(na);
    }
  }
}

/**
 * Filter then sort. Returns a new array; input is not mutated.
 * Rows whose `card` field is null pass the no-card-dependent filters
 * (priorityOnly, matchOnly) but fail any filter that needs card data
 * (query, set, variant). This is the conservative choice — surfacing
 * a row under a filter that we can't validate against would lie to
 * the user.
 */
export function applyListToolbar<TRow extends ListRowMeta>(
  rows: readonly TRow[],
  filters: ListFilters,
  sort: ListSortMode,
  priceMode: PriceMode,
): TRow[] {
  const q = filters.query.trim().toLowerCase();
  const variantSet = filters.selectedVariants.length > 0
    ? new Set(filters.selectedVariants)
    : null;
  const setMatcher = buildSetMatcher(filters.selectedSets);

  const filtered = rows.filter(row => {
    if (filters.priorityOnly && !row.isPriority) return false;
    if (filters.matchOnly && !row.isMatch) return false;

    const card = row.card;
    if (!card) {
      // Card unresolved — fail any filter that needs it.
      if (q) return false;
      if (variantSet) return false;
      if (setMatcher) return false;
      return true;
    }

    if (q) {
      const name = rowDisplayName(card);
      if (!name.includes(q)) return false;
    }

    if (setMatcher && !setMatcher(card.set)) return false;

    if (variantSet) {
      // Cross-reference row.variantTags against the filter. Empty
      // variantTags is impossible by contract — any Wants/Available
      // row has at least one tag.
      let hit = false;
      for (const tag of row.variantTags) {
        if (variantSet.has(tag)) { hit = true; break; }
      }
      if (!hit) return false;
    }

    return true;
  });

  // Sort needs a new array (filter already returns one, so this is
  // safe to mutate in place). DefaultSortCtx is built once from the
  // filtered set so cross-family primary-number lookups stay O(1)
  // per comparison.
  const defaultCtx = buildDefaultSortCtx(filtered);
  filtered.sort((a, b) => cmpByMode(a, b, sort, priceMode, defaultCtx));
  return filtered;
}

/**
 * Count of axes the user has narrowed beyond their defaults. Drives
 * the "Clear all" affordance + the "3 filters applied, no matches"
 * empty-state copy.
 */
export function activeFilterCount(filters: ListFilters): number {
  let n = 0;
  if (filters.query.trim().length > 0) n++;
  if (filters.selectedSets.length > 0) n++;
  if (filters.selectedVariants.length > 0) n++;
  if (filters.priorityOnly) n++;
  if (filters.matchOnly) n++;
  return n;
}

/**
 * Re-export `extractVariantLabel` under the listToolbar surface so
 * callers building `variantTags` for an AvailableItem row don't have
 * to reach into `variants.ts` directly. Wants rows derive tags from
 * their stored restriction; Available rows derive from the resolved
 * card. Centralizing here makes the convention discoverable.
 */
export function variantTagFromCard(card: CardVariant): string {
  return extractVariantLabel(card.name);
}
