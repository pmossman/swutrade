import { useMemo } from 'react';
import { SETS } from '../types';
import { CANONICAL_VARIANTS, variantBadgeColor } from '../variants';
import type { SelectionFilters } from '../hooks/useSelectionFilters';
import { CollapsibleChipFilter, Chip } from './CollapsibleChipFilter';
import { MAIN_GROUP, SPECIAL_GROUP } from '../applySelectionFilters';

const MAIN_SETS = SETS.filter(s => s.category === 'main');

function variantChipLabel(v: string): string {
  if (v === 'Hyperspace Foil') return 'HS Foil';
  if (v === 'Prestige Foil') return 'Pres Foil';
  return v;
}

function summarize(selected: readonly string[], noneLabel: string, format: (s: string) => string = (s) => s): string {
  if (selected.length === 0) return noneLabel;
  if (selected.length === 1) return format(selected[0]);
  if (selected.length <= 3) return selected.map(format).join(', ');
  return `${selected.length} selected`;
}

const SET_CODE_BY_SLUG = new Map(SETS.map(s => [s.slug, s.code] as const));

function setSummaryLabel(slug: string): string {
  if (slug === MAIN_GROUP) return 'Main';
  if (slug === SPECIAL_GROUP) return 'Special';
  return SET_CODE_BY_SLUG.get(slug) ?? slug;
}

interface SelectionFilterBarProps {
  filters: SelectionFilters;
}

/**
 * Two collapsible chip filters — Variant and Set — sharing a single
 * SelectionFilters state. Set filter shows main sets by default with
 * a "Show promos" sub-expander so 20+ promo chips don't crowd the UI.
 */
export function SelectionFilterBar({ filters }: SelectionFilterBarProps) {
  const variantSummary = summarize(filters.selectedVariants, 'Any');
  const setSummary = useMemo(() => {
    return summarize(filters.selectedSets, 'All sets', setSummaryLabel);
  }, [filters.selectedSets]);

  return (
    <div className="flex items-start gap-2 flex-wrap">
      <CollapsibleChipFilter
        label="Variant"
        summary={variantSummary}
        action={
          filters.selectedVariants.length > 0 ? (
            <button
              type="button"
              onClick={filters.clearVariants}
              className="text-[10px] text-gray-500 hover:text-gold transition-colors"
            >
              Clear
            </button>
          ) : undefined
        }
      >
        <Chip
          active={filters.selectedVariants.length === 0}
          onClick={filters.clearVariants}
          colorClass="bg-gold/15 text-gold border-gold/40"
        >
          Any
        </Chip>
        {CANONICAL_VARIANTS.map(v => {
          const active = (filters.selectedVariants as readonly string[]).includes(v);
          return (
            <Chip
              key={v}
              active={active}
              onClick={() => filters.toggleVariant(v)}
              colorClass={variantBadgeColor(v)}
            >
              {variantChipLabel(v)}
            </Chip>
          );
        })}
      </CollapsibleChipFilter>

      <CollapsibleChipFilter
        label="Set"
        summary={setSummary}
        action={
          filters.selectedSets.length > 0 ? (
            <button
              type="button"
              onClick={filters.clearSets}
              className="text-[10px] text-gray-500 hover:text-gold transition-colors"
            >
              Clear
            </button>
          ) : undefined
        }
      >
        <Chip
          active={filters.selectedSets.length === 0}
          onClick={filters.clearSets}
          colorClass="bg-gold/15 text-gold border-gold/40"
        >
          All
        </Chip>
        <Chip
          active={filters.selectedSets.includes(MAIN_GROUP)}
          onClick={() => filters.replaceGroup(
            filters.selectedSets.includes(MAIN_GROUP) ? null : MAIN_GROUP,
          )}
          colorClass="bg-gold/15 text-gold border-gold/40"
        >
          Main
        </Chip>
        <Chip
          active={filters.selectedSets.includes(SPECIAL_GROUP)}
          onClick={() => filters.replaceGroup(
            filters.selectedSets.includes(SPECIAL_GROUP) ? null : SPECIAL_GROUP,
          )}
          colorClass="bg-gold/15 text-gold border-gold/40"
        >
          Special
        </Chip>
        <span className="w-px h-5 bg-space-700 mx-1" aria-hidden />
        {MAIN_SETS.map(s => (
          <Chip
            key={s.slug}
            active={filters.selectedSets.includes(s.slug)}
            onClick={() => filters.toggleSet(s.slug)}
          >
            {s.code}
          </Chip>
        ))}
      </CollapsibleChipFilter>

    </div>
  );
}
