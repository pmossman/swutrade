import { SlidersHorizontal } from 'lucide-react';
import { Popover } from './Popover';
import { Chip } from './CollapsibleChipFilter';
import { SELECTABLE_RARITIES, type SelectableRarity } from '../hooks/useSelectionFilters';
import type { SortBy } from '../persistence';

interface MoreFiltersPopoverProps {
  selectedRarities: readonly SelectableRarity[];
  sortBy: SortBy;
  onToggleRarity: (r: SelectableRarity) => void;
  onChangeSortBy: (s: SortBy) => void;
  /** Reset rarity + sort to defaults without touching variant/set. */
  onClear: () => void;
  /** Surfaces as a small badge on the trigger when non-zero so users
   *  know without opening whether anything's narrowing their view. */
  activeCount: number;
}

/**
 * Single-button entry-point for niche picker filters that don't earn
 * a permanent chip row (mobile is tight). Houses two axes today:
 *
 *   - **Rarity** — multi-select chips for Common/Uncommon/Rare/Legendary.
 *     Empty = allow all. Special is intentionally absent (set's
 *     Special preset covers promo-only browsing).
 *   - **Sort** — radio between Relevance (default; the existing
 *     name-match-first / newest-set-first ordering) and Price: high
 *     to low (flattens to one synthetic group across all sets).
 *
 * Designed to grow: a future Group-by axis (set vs aspect) would
 * slot in below Sort without re-shuffling the trigger.
 */
export function MoreFiltersPopover({
  selectedRarities,
  sortBy,
  onToggleRarity,
  onChangeSortBy,
  onClear,
  activeCount,
}: MoreFiltersPopoverProps) {
  return (
    <Popover
      align="right"
      panelClassName="p-3 w-[260px]"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label="More filters"
          aria-expanded={open}
          className="relative flex items-center gap-1 px-2 py-1 rounded-md bg-space-800/60 border border-space-700 hover:border-gray-500 text-[11px] transition-colors"
        >
          <SlidersHorizontal className="w-3 h-3 text-gray-400" aria-hidden />
          <span className="font-bold tracking-[0.1em] uppercase text-gray-400">More</span>
          {activeCount > 0 && (
            <span
              className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-gold/20 border border-gold/40 text-gold text-[9px] font-bold tabular-nums"
              aria-label={`${activeCount} more filter${activeCount === 1 ? '' : 's'} active`}
            >
              {activeCount}
            </span>
          )}
        </button>
      )}
    >
      {() => (
        <div className="flex flex-col gap-3 text-xs text-gray-200">
          {/* Rarity */}
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] tracking-[0.1em] uppercase font-bold text-gray-500">
                Rarity
              </span>
              {selectedRarities.length > 0 && (
                <span className="text-[10px] text-gray-500">
                  {selectedRarities.length} selected
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SELECTABLE_RARITIES.map(r => (
                <Chip
                  key={r}
                  active={selectedRarities.includes(r)}
                  onClick={() => onToggleRarity(r)}
                  colorClass={RARITY_COLORS[r]}
                >
                  {r}
                </Chip>
              ))}
            </div>
          </section>

          {/* Sort */}
          <section className="flex flex-col gap-1.5">
            <span className="text-[10px] tracking-[0.1em] uppercase font-bold text-gray-500">
              Sort
            </span>
            <div className="flex flex-col gap-1">
              <SortOption
                label="Relevance"
                hint="Name match · newest set first"
                checked={sortBy === 'relevance'}
                onSelect={() => onChangeSortBy('relevance')}
              />
              <SortOption
                label="Price: high to low"
                hint="Across all sets, by current price mode"
                checked={sortBy === 'price-desc'}
                onSelect={() => onChangeSortBy('price-desc')}
              />
            </div>
          </section>

          {activeCount > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="self-end text-[10px] text-gray-500 hover:text-gold transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}

/** Color hints on the rarity chips — light, not domain-canonical
 *  because SWU doesn't paint rarities the way Magic does. Just
 *  enough tone to read as "these are different categories" at a
 *  glance. */
const RARITY_COLORS: Record<SelectableRarity, string> = {
  Common: 'bg-gray-700/40 text-gray-300 border-gray-600',
  Uncommon: 'bg-emerald-900/30 text-emerald-300 border-emerald-700/50',
  Rare: 'bg-blue-900/30 text-blue-300 border-blue-700/50',
  Legendary: 'bg-amber-900/30 text-amber-300 border-amber-600/60',
};

function SortOption({
  label,
  hint,
  checked,
  onSelect,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors
        ${checked
          ? 'bg-gold/15 border border-gold/40 text-gold'
          : 'bg-space-800/40 border border-space-700 text-gray-300 hover:border-gray-500'}`}
    >
      <span
        aria-hidden
        className={`mt-0.5 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border shrink-0
          ${checked ? 'border-gold bg-gold/30' : 'border-space-600 bg-space-900'}`}
      >
        {checked && <span className="w-1.5 h-1.5 rounded-full bg-gold" />}
      </span>
      <span className="flex flex-col">
        <span className="text-[11px] font-semibold">{label}</span>
        {hint && <span className="text-[10px] text-gray-500 leading-tight mt-0.5">{hint}</span>}
      </span>
    </button>
  );
}
