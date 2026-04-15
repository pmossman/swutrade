import { SETS } from '../types';
import { MAIN_GROUP, SPECIAL_GROUP } from '../applySelectionFilters';

const SET_CODE_BY_SLUG = new Map(SETS.map(s => [s.slug, s.code] as const));

/**
 * Compact summary for the collapsed-state of a chip filter:
 *   []                   → noneLabel ("Any" / "All sets")
 *   [a]                  → format(a)
 *   [a,b] / [a,b,c]      → joined names
 *   ≥4 entries           → "N selected"
 *
 * `format` lets callers project slugs / codes / chip-labels — set
 * filters use a slug → code lookup, variant filters use the chip-label
 * abbreviation, etc.
 */
export function summarizeSelection(
  selected: readonly string[],
  noneLabel: string,
  format: (s: string) => string = (s) => s,
): string {
  if (selected.length === 0) return noneLabel;
  if (selected.length === 1) return format(selected[0]);
  if (selected.length <= 3) return selected.map(format).join(', ');
  return `${selected.length} selected`;
}

export function setSummaryLabel(slug: string): string {
  if (slug === MAIN_GROUP) return 'Main';
  if (slug === SPECIAL_GROUP) return 'Special';
  return SET_CODE_BY_SLUG.get(slug) ?? slug;
}
