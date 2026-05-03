import type { SetSearchGroup } from './hooks/useCardSearch';
import type { CardGroup, PriceMode } from './types';
import { SETS } from './types';
import { extractVariantLabel } from './variants';
import { getCardPrice } from './services/priceService';
import type { SortBy } from './persistence';

/** Pseudo-slugs that group sets by category for single-tap selection. */
export const MAIN_GROUP = 'group:main';
export const SPECIAL_GROUP = 'group:special';

const MAIN_SLUGS = new Set(SETS.filter(s => s.category === 'main').map(s => s.slug));
const SPECIAL_SLUGS = new Set(SETS.filter(s => s.category === 'promo').map(s => s.slug));

/** Synthetic setSlug used when sortBy='price-desc' collapses
 *  results into a single flat list. The renderer treats this slug
 *  the same as any other; only the setName changes the sticky
 *  header copy. */
const PRICE_DESC_SLUG = '__by-price__';

export interface ApplyFiltersOptions {
  selectedSets: readonly string[];
  selectedVariants: readonly string[];
  selectedRarities?: readonly string[];
  sortBy?: SortBy;
  /** Active price mode (market / low). Used as the sort key when
   *  sortBy='price-desc' so the displayed price the user sees is
   *  the one driving the order. Defaults to 'market'. */
  priceMode?: PriceMode;
}

/**
 * Apply positive selection filters to a flat list of search result
 * groups. Empty selection means "allow all" for that dimension.
 *
 * The set filter supports two pseudo-slugs, MAIN_GROUP and
 * SPECIAL_GROUP, which match any set in that category — so a user
 * can opt into the whole category with one chip.
 *
 * Rarity filter narrows to cards whose `rarity` is in the set.
 * Empty array = allow all rarities.
 *
 * sortBy='price-desc' flattens the result into a single synthetic
 * SetSearchGroup ('Sorted by price') with all groups inter-leaved
 * and ordered by max-card-price descending. sortBy='relevance'
 * preserves the input ordering (which the search step already
 * tuned for name-match relevance + newest-set-first).
 *
 * Set groups that end up with no visible cards are dropped so the
 * results don't render empty sections.
 */
export function applySelectionFilters(
  results: SetSearchGroup[],
  options: ApplyFiltersOptions,
): SetSearchGroup[] {
  const {
    selectedSets,
    selectedVariants,
    selectedRarities = [],
    sortBy = 'relevance',
    priceMode = 'market',
  } = options;

  const setMatcher = buildSetMatcher(selectedSets);
  const variantFilter = selectedVariants.length > 0 ? new Set(selectedVariants) : null;
  const rarityFilter = selectedRarities.length > 0 ? new Set(selectedRarities) : null;

  // Walk + filter once. Empty groups / sets get dropped on the way
  // out so we never render empty sections.
  const filtered = results
    .filter(sg => !setMatcher || setMatcher(sg.setSlug))
    .map(sg => ({
      ...sg,
      groups: sg.groups
        .map(g => {
          const survivors = g.variants.filter(c => {
            if (variantFilter && !variantFilter.has(extractVariantLabel(c.name))) return false;
            if (rarityFilter && !rarityFilter.has(c.rarity)) return false;
            return true;
          });
          return survivors.length > 0 ? { ...g, variants: survivors } : null;
        })
        .filter((g): g is CardGroup => g !== null),
    }))
    .filter(sg => sg.groups.length > 0);

  if (sortBy !== 'price-desc') return filtered;

  // Price-desc: flatten into one synthetic group sorted by each
  // card-family's highest active-mode price. Families with no
  // priced variants sink to the bottom.
  const allGroups = filtered.flatMap(sg => sg.groups);
  allGroups.sort((a, b) => groupTopPrice(b, priceMode) - groupTopPrice(a, priceMode));
  if (allGroups.length === 0) return [];
  return [{
    setSlug: PRICE_DESC_SLUG,
    setCode: '$',
    setName: 'Sorted by price (high → low)',
    groups: allGroups,
  }];
}

function groupTopPrice(g: CardGroup, mode: PriceMode): number {
  let max = -Infinity;
  for (const v of g.variants) {
    const p = getCardPrice(v, mode);
    if (p !== null && p > max) max = p;
  }
  // Groups with no priced variants sort last; -1 is below the
  // cheapest real card ($0.02 in the catalog as of 2026-05).
  return max === -Infinity ? -1 : max;
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
