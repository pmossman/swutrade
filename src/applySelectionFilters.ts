import type { SetSearchGroup } from './hooks/useCardSearch';
import { SETS } from './types';
import { extractVariantLabel } from './variants';

/** Pseudo-slug that groups all promo sets into a single filter chip. */
export const PROMOS_GROUP = 'promos';

const PROMO_SLUGS = new Set(SETS.filter(s => s.category === 'promo').map(s => s.slug));

/**
 * Apply positive selection filters to a flat list of search result
 * groups. Empty selection means "allow all" for that dimension.
 *
 * The set filter supports the 'promos' pseudo-slug which matches any
 * promo-category set, so a single "Promos" chip can stand in for the
 * 20+ individual promo printings.
 *
 * Set groups that end up with no visible cards are dropped so the
 * results don't render empty sections.
 */
export function applySelectionFilters(
  results: SetSearchGroup[],
  selectedSets: readonly string[],
  selectedVariants: readonly string[],
): SetSearchGroup[] {
  const setMatcher = buildSetMatcher(selectedSets);
  const variantFilter = selectedVariants.length > 0 ? new Set(selectedVariants) : null;
  if (!setMatcher && !variantFilter) return results;

  return results
    .filter(sg => !setMatcher || setMatcher(sg.setSlug))
    .map(sg => ({
      ...sg,
      groups: sg.groups
        .map(g => ({
          ...g,
          variants: variantFilter
            ? g.variants.filter(c => variantFilter.has(extractVariantLabel(c.name)))
            : g.variants,
        }))
        .filter(g => g.variants.length > 0),
    }))
    .filter(sg => sg.groups.length > 0);
}

function buildSetMatcher(selected: readonly string[]): ((slug: string) => boolean) | null {
  if (selected.length === 0) return null;
  const exact = new Set<string>();
  let includePromos = false;
  for (const entry of selected) {
    if (entry === PROMOS_GROUP) includePromos = true;
    else exact.add(entry);
  }
  return (slug: string) => exact.has(slug) || (includePromos && PROMO_SLUGS.has(slug));
}
