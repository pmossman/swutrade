import { useCallback, useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, Search, X } from 'lucide-react';
import { Popover } from '../Popover';
import { Chip } from '../ui/Chip';
import { VariantChipGroup, SetChipGroup } from '../SelectionFilterBar';
import {
  type ListFilters,
  type ListSortMode,
  activeFilterCount,
  DEFAULT_LIST_FILTERS,
} from './applyListToolbar';
import { setSummaryLabel, summarizeSelection } from '../../utils/filterSummaries';
import type { CanonicalVariant } from '../../variants';

/**
 * Shared toolbar that sits above every list surface in the app —
 * Wishlist, Binder, ProfileView (both Wants + Available tabs).
 *
 * Owns no state of its own — value + callbacks pattern so the host
 * decides whether to persist to localStorage (Wishlist/Binder) or
 * keep ephemeral (ProfileView's matchMode default-on calculation).
 *
 * Vocabulary deliberately mirrors the picker's `SelectionFilterBar`
 * — variant + set chip groups are imported directly so visual
 * language stays cross-consistent and a user who learns one filter
 * surface already knows the other. The "More" popover adds the
 * list-specific axes (sort, priority-only, matchOnly).
 */

export type ListToolbarMode = 'wishlist' | 'binder' | 'profile-self' | 'profile-other';

interface ListToolbarProps {
  filters: ListFilters;
  onChangeFilters: (next: ListFilters) => void;
  sort: ListSortMode;
  onChangeSort: (next: ListSortMode) => void;
  mode: ListToolbarMode;
  /** Total row count BEFORE filters — feeds the "0 of N" empty-state
   *  copy. Hosts compute this from their unfiltered source. */
  totalCount: number;
  /** Row count AFTER filters — drives the count display on the right
   *  side of the toolbar and the "X of Y" indicator when narrowed. */
  filteredCount: number;
  /** Optional label override for the match toggle. Default labels
   *  ("Only matches with your wants" / "Only matches with your
   *  available") work in most profile contexts. */
  matchToggleLabel?: string;
}

const DEFAULT_SORT_LABEL: Record<ListToolbarMode, string> = {
  // Wishlist's default keeps the priority-first tier in front of the
  // set-grouped sort. The others go straight to set ordering.
  'wishlist': 'Priority · by set',
  'binder': 'By set (newest first)',
  'profile-self': 'By set (newest first)',
  'profile-other': 'By set (newest first)',
};

const SEARCH_DEBOUNCE_MS = 80;

export function ListToolbar({
  filters,
  onChangeFilters,
  sort,
  onChangeSort,
  mode,
  totalCount,
  filteredCount,
  matchToggleLabel,
}: ListToolbarProps) {
  // Search input has its own local mirror so typing feels instant.
  // We debounce-emit upward at SEARCH_DEBOUNCE_MS — matches the
  // picker's debounce rhythm (see ListCardPicker.tsx) so users don't
  // notice a different cadence between the two surfaces.
  const [searchInput, setSearchInput] = useState(filters.query);
  const lastEmittedQueryRef = useRef(filters.query);

  // If the host resets filters externally (e.g., "Clear all"), pull
  // the input back in sync.
  useEffect(() => {
    if (filters.query !== lastEmittedQueryRef.current) {
      setSearchInput(filters.query);
      lastEmittedQueryRef.current = filters.query;
    }
  }, [filters.query]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== filters.query) {
        lastEmittedQueryRef.current = searchInput;
        onChangeFilters({ ...filters, query: searchInput });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, filters, onChangeFilters]);

  const updateFilter = useCallback(<K extends keyof ListFilters>(key: K, value: ListFilters[K]) => {
    onChangeFilters({ ...filters, [key]: value });
  }, [filters, onChangeFilters]);

  const toggleVariant = useCallback((v: CanonicalVariant) => {
    const arr = filters.selectedVariants;
    const next = arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
    updateFilter('selectedVariants', next);
  }, [filters.selectedVariants, updateFilter]);

  const clearVariants = useCallback(() => {
    if (filters.selectedVariants.length > 0) updateFilter('selectedVariants', []);
  }, [filters.selectedVariants, updateFilter]);

  const toggleSet = useCallback((slug: string) => {
    // Selecting an individual set when a group preset is active wipes
    // the preset — matches the picker's `toggleSetReducer` rules so
    // the two surfaces don't diverge in how presets and chips interact.
    const arr = filters.selectedSets.filter(s => s !== 'group:main' && s !== 'group:special');
    const next = arr.includes(slug) ? arr.filter(x => x !== slug) : [...arr, slug];
    updateFilter('selectedSets', next);
  }, [filters.selectedSets, updateFilter]);

  const selectGroup = useCallback((group: string | null) => {
    updateFilter('selectedSets', group === null ? [] : [group]);
  }, [updateFilter]);

  const clearSets = useCallback(() => {
    if (filters.selectedSets.length > 0) updateFilter('selectedSets', []);
  }, [filters.selectedSets, updateFilter]);

  const clearAll = useCallback(() => {
    setSearchInput('');
    onChangeFilters(DEFAULT_LIST_FILTERS);
  }, [onChangeFilters]);

  const setSummary = summarizeSelection(filters.selectedSets, 'All sets', setSummaryLabel);
  const activeCount = activeFilterCount(filters);

  const showMatchToggle = mode === 'profile-other';
  const showPriorityToggle = mode === 'wishlist';
  const defaultMatchLabel = matchToggleLabel ?? 'Only matches with your wishlist';

  return (
    <div className="flex flex-col gap-2 border-b border-space-800 pb-2 mb-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" aria-hidden />
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search this list..."
            className="w-full pl-8 pr-8 py-1.5 rounded-lg bg-space-800 border border-space-700 focus:border-gold/50 focus:outline-none text-sm text-gray-100 placeholder:text-gray-600"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-gray-500 hover:text-gold transition-colors"
            >
              <X className="w-3 h-3" aria-hidden />
            </button>
          )}
        </div>
        <span
          className={`shrink-0 text-[11px] tabular-nums whitespace-nowrap ${
            activeCount > 0 ? 'text-gold font-semibold' : 'text-gray-500'
          }`}
        >
          {activeCount > 0
            ? `${filteredCount} of ${totalCount}`
            : `${totalCount}`}
        </span>
      </div>

      <div className="flex items-start gap-2 flex-wrap">
        <VariantChipGroup
          selectedVariants={filters.selectedVariants}
          onToggle={toggleVariant}
          onClear={clearVariants}
        />
        <SetChipGroup
          summary={setSummary}
          selectedSets={filters.selectedSets}
          onToggleSet={toggleSet}
          onSelectGroup={selectGroup}
          onClear={clearSets}
        />
        <ListMorePopover
          sort={sort}
          onChangeSort={onChangeSort}
          showPriorityToggle={showPriorityToggle}
          priorityOnly={!!filters.priorityOnly}
          onTogglePriorityOnly={() => updateFilter('priorityOnly', !filters.priorityOnly)}
          showMatchToggle={showMatchToggle}
          matchOnly={!!filters.matchOnly}
          onToggleMatchOnly={() => updateFilter('matchOnly', !filters.matchOnly)}
          matchToggleLabel={defaultMatchLabel}
          defaultSortLabel={DEFAULT_SORT_LABEL[mode]}
          activeExtraCount={(filters.priorityOnly ? 1 : 0) + (filters.matchOnly ? 1 : 0) + (sort !== 'default' ? 1 : 0)}
        />
        {activeCount > 0 && (
          <button
            type="button"
            onClick={clearAll}
            // Gold tinge — same convention as SelectionFilterBar's
            // aggregate clear. Surfaces the "you have N filters
            // narrowing this view" state in peripheral vision so
            // users don't go hunting for a missing card under stale
            // filters.
            className="ml-auto self-center text-[11px] font-semibold text-gold/80 hover:text-gold transition-colors whitespace-nowrap"
            aria-label={`Clear ${activeCount} active filter${activeCount === 1 ? '' : 's'}`}
          >
            Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </div>
  );
}

interface ListMorePopoverProps {
  sort: ListSortMode;
  onChangeSort: (next: ListSortMode) => void;
  showPriorityToggle: boolean;
  priorityOnly: boolean;
  onTogglePriorityOnly: () => void;
  showMatchToggle: boolean;
  matchOnly: boolean;
  onToggleMatchOnly: () => void;
  matchToggleLabel: string;
  defaultSortLabel: string;
  activeExtraCount: number;
}

function ListMorePopover({
  sort,
  onChangeSort,
  showPriorityToggle,
  priorityOnly,
  onTogglePriorityOnly,
  showMatchToggle,
  matchOnly,
  onToggleMatchOnly,
  matchToggleLabel,
  defaultSortLabel,
  activeExtraCount,
}: ListMorePopoverProps) {
  return (
    <Popover
      panelClassName="p-3 w-[280px]"
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
          {activeExtraCount > 0 && (
            <span
              className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-gold/20 border border-gold/40 text-gold text-[9px] font-bold tabular-nums"
              aria-label={`${activeExtraCount} more filter${activeExtraCount === 1 ? '' : 's'} active`}
            >
              {activeExtraCount}
            </span>
          )}
        </button>
      )}
    >
      {() => (
        <div className="flex flex-col gap-3 text-xs text-gray-200">
          {(showPriorityToggle || showMatchToggle) && (
            <section className="flex flex-col gap-1.5">
              <span className="text-[10px] tracking-[0.1em] uppercase font-bold text-gray-500">
                Show
              </span>
              <div className="flex flex-wrap gap-1.5">
                {showPriorityToggle && (
                  <Chip
                    active={priorityOnly}
                    onClick={onTogglePriorityOnly}
                    colorClass="bg-gold/15 text-gold border-gold/40"
                  >
                    {priorityOnly ? 'Priority only ✓' : 'Priority only'}
                  </Chip>
                )}
                {showMatchToggle && (
                  <Chip
                    active={matchOnly}
                    onClick={onToggleMatchOnly}
                    colorClass="bg-emerald-500/15 text-emerald-200 border-emerald-500/40"
                  >
                    {matchOnly ? `${matchToggleLabel} ✓` : matchToggleLabel}
                  </Chip>
                )}
              </div>
            </section>
          )}

          <section className="flex flex-col gap-1.5">
            <span className="text-[10px] tracking-[0.1em] uppercase font-bold text-gray-500">
              Sort
            </span>
            <div className="flex flex-col gap-1">
              <SortRadio
                label={defaultSortLabel}
                checked={sort === 'default'}
                onSelect={() => onChangeSort('default')}
              />
              <SortRadio
                label="Newest first"
                checked={sort === 'newest'}
                onSelect={() => onChangeSort('newest')}
              />
              <SortRadio
                label="Oldest first"
                checked={sort === 'oldest'}
                onSelect={() => onChangeSort('oldest')}
              />
              <SortRadio
                label="Price: high to low"
                checked={sort === 'price-desc'}
                onSelect={() => onChangeSort('price-desc')}
              />
              <SortRadio
                label="Price: low to high"
                checked={sort === 'price-asc'}
                onSelect={() => onChangeSort('price-asc')}
              />
              <SortRadio
                label="Name: A → Z"
                checked={sort === 'name-asc'}
                onSelect={() => onChangeSort('name-asc')}
              />
              <SortRadio
                label="Name: Z → A"
                checked={sort === 'name-desc'}
                onSelect={() => onChangeSort('name-desc')}
              />
            </div>
          </section>
        </div>
      )}
    </Popover>
  );
}

/**
 * Body content for an empty-state when filters are likely the cause.
 * When `activeCount > 0` it names the filters as the reason and
 * surfaces an inline "Clear N filters" button so the user doesn't
 * have to scroll back up to the toolbar. When `activeCount === 0`
 * the host's "list is empty / nothing to show" copy belongs instead.
 *
 * Lives next to `ListToolbar` because the count semantics + button
 * styling MUST match what the toolbar's aggregate clear shows; a
 * second clear-button visual would dilute the gold-tinge convention
 * for narrowing state.
 */
export function FilterAwareEmptyBody({
  activeCount,
  onClear,
}: {
  activeCount: number;
  onClear: () => void;
}) {
  if (activeCount === 0) {
    return <>Nothing to show.</>;
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <span>
        {activeCount === 1
          ? '1 filter is hiding every row.'
          : `${activeCount} filters are hiding every row.`}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="text-[11px] font-semibold text-gold/80 hover:text-gold transition-colors px-3 py-1 rounded-md border border-gold/30 hover:border-gold/60"
      >
        Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
      </button>
    </div>
  );
}

function SortRadio({
  label,
  checked,
  onSelect,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors
        ${checked
          ? 'bg-gold/15 border border-gold/40 text-gold'
          : 'bg-space-800/40 border border-space-700 text-gray-300 hover:border-gray-500'}`}
    >
      <span
        aria-hidden
        className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border shrink-0
          ${checked ? 'border-gold bg-gold/30' : 'border-space-600 bg-space-900'}`}
      >
        {checked && <span className="w-1.5 h-1.5 rounded-full bg-gold" />}
      </span>
      <span className="text-[11px] font-semibold">{label}</span>
    </button>
  );
}
