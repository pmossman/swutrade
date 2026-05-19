import type { CardVariant, PriceMode } from '../../types';
import { extractVariantLabel } from '../../variants';
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
  // `card.number` is a string like "001" or "078"; numeric parse so
  // ordering matches the printed-card order, not lexicographic
  // ("10" > "9" the right way).
  const n = parseInt(card.number, 10);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
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

function cmpDefault<TRow extends ListRowMeta>(a: TRow, b: TRow): number {
  // Tiered default sort:
  //   1. Priority first (only matters on wishlist — binder rows
  //      never set isPriority, so the priority tier collapses to
  //      a no-op on that surface).
  //   2. Set, newest first. Real users think of their collection in
  //      set blocks ("the LAW cards I have", "my old SOR stuff");
  //      newest-first puts the active-meta set at the top.
  //   3. Aspect, canonical order (Heroism, Vigilance, Command,
  //      Cunning, Aggression, Villainy). Groups same-color cards
  //      visually within each set block — easier to scan.
  //   4. Card number ascending. The printed-card order, which
  //      conveniently keeps aspectless cards (Leaders / Bases by
  //      convention low numbers) at the top of each aspect group.
  //   5. addedAt as a stable tie-breaker so two rows for the same
  //      card never swap on re-render.
  const pa = a.isPriority ? 1 : 0;
  const pb = b.isPriority ? 1 : 0;
  if (pa !== pb) return pb - pa;

  const sa = setRecency(a.card);
  const sb = setRecency(b.card);
  if (sa !== sb) return sb - sa;

  const ia = aspectIndex(a.card);
  const ib = aspectIndex(b.card);
  if (ia !== ib) return ia - ib;

  const na = cardNumber(a.card);
  const nb = cardNumber(b.card);
  if (na !== nb) return na - nb;

  return a.addedAt - b.addedAt;
}

function cmpByMode<TRow extends ListRowMeta>(
  a: TRow,
  b: TRow,
  sort: ListSortMode,
  priceMode: PriceMode,
): number {
  switch (sort) {
    case 'default':
      return cmpDefault(a, b);
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
  // safe to mutate in place).
  filtered.sort((a, b) => cmpByMode(a, b, sort, priceMode));
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
