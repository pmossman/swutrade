import { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import type { CardVariant, PriceMode, TradeCard } from '../types';
import { useCardSearch, browseAllGroups } from '../hooks/useCardSearch';
import type { SelectionFilters } from '../hooks/useSelectionFilters';
import { applySelectionFilters } from '../applySelectionFilters';
import { SearchResults } from './SearchResults';
import { SelectionFilterBar } from './SelectionFilterBar';
import { summarizeSelection, setSummaryLabel } from '../utils/filterSummaries';
import { variantChipLabel, type CanonicalVariant } from '../variants';
import { adjustPrice, getCardPrice } from '../services/priceService';

export type AccentColor = 'emerald' | 'blue';

const saberBarColors: Record<AccentColor, string> = {
  emerald: 'bg-gradient-to-b from-emerald-300 via-emerald-500 to-emerald-700 shadow-[0_0_12px_rgba(52,211,153,0.55)]',
  blue: 'bg-gradient-to-b from-blue-300 via-blue-500 to-blue-700 shadow-[0_0_12px_rgba(96,165,250,0.55)]',
};

const headerColors: Record<AccentColor, string> = {
  emerald: 'border-emerald-500/30 text-emerald-300',
  blue: 'border-blue-500/30 text-blue-300',
};

const searchBorderColors: Record<AccentColor, string> = {
  emerald: 'focus:border-emerald-500/50 focus:ring-emerald-500/20',
  blue: 'focus:border-blue-500/50 focus:ring-blue-500/20',
};

const doneButtonColors: Record<AccentColor, string> = {
  emerald: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  blue: 'bg-blue-600 hover:bg-blue-500 text-white',
};

export interface SourceChipConfig {
  /** Stable identity; survives across re-renders so seeded chip
   *  activation matches the chip the parent intends. */
  id: string;
  /** Display label, e.g. "My available" / "They want". */
  label: string;
  /** Cards eligible for this source. The chip auto-hides when this
   *  drops to empty (parent does the qty-aware filtering). */
  cards: CardVariant[];
  /** When true, the chip renders even at cards.length === 0.
   *  Currently used for the Overlap chip — "0" is itself a useful
   *  signal ("no match pool; go look at 'They want' to discover
   *  what to source"). */
  alwaysVisible?: boolean;
}

export interface TradeSearchOverlaySeed {
  /** Pre-fill the search input. Useful for the swap-variant kebab. */
  query?: string;
  /** Chip ids to activate when the overlay opens. Useful for the
   *  shared-list landing handoff that deep-links into "They want". */
  activeChips?: string[];
}

interface TradeSearchOverlayProps {
  open: boolean;
  onDismiss: () => void;

  // Side identity
  label: string;
  accentColor: AccentColor;
  /** Counterpart handle when we're in a propose / shared-list context.
   *  Rendered as "for @alice" in the header to keep users oriented —
   *  the full-screen overlay was burying the "who am I trading with"
   *  context and making the picker feel disconnected from its home. */
  counterpartHandle?: string | null;

  // Card universe + filters
  allCards: CardVariant[];
  isLoading: boolean;
  filters: SelectionFilters;

  // Source chips — caller decides labels and which cards qualify.
  sourceChips: SourceChipConfig[];

  // Current side's trade rows — feeds the SearchResults grid (×N
  // saved-qty badges, etc.)
  cards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;

  // Trade actions wired through to SearchResults' tile click handlers.
  onAdd: (card: CardVariant) => void;
  onChangeQty: (key: string, delta: number) => void;
  onRemove: (key: string) => void;

  /**
   * One-shot seed for the overlay's internal state. Set non-null to
   * apply (query and/or activeChips), then the overlay fires
   * `onSeedConsumed` so the parent can clear it. Mirrors the
   * `autoOpenSharedLink` pattern already in use elsewhere.
   */
  seed?: TradeSearchOverlaySeed | null;
  onSeedConsumed?: () => void;
}

/**
 * Full-screen card-picker overlay. Owns its own search state via
 * `useCardSearch` so the parent stays focused on the trade panel
 * itself; communication with the parent is fully declarative through
 * the `open` / `onDismiss` pair plus the optional `seed` prop.
 */
export function TradeSearchOverlay({
  open,
  onDismiss,
  label,
  accentColor,
  counterpartHandle,
  allCards,
  isLoading,
  filters,
  sourceChips,
  cards,
  percentage,
  priceMode,
  onAdd,
  onChangeQty,
  onRemove,
  seed,
  onSeedConsumed,
}: TradeSearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useCardSearch({ allCards, setFilter: null });
  const [activeChipIds, setActiveChipIds] = useState<readonly string[]>([]);
  // Filter row collapses behind a summary control so the default
  // state shows the grid, not three rows of toggles. Expands on tap.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const hasQuery = search.query.length >= 2;
  const hdr = headerColors[accentColor];
  const searchBorder = searchBorderColors[accentColor];

  // Auto-deactivate any chip whose pool drops to empty (e.g. user
  // pulls the last "My available" card into the trade). Without this
  // the grid would show "No cards match your filters" while a
  // gold-active chip was still selected.
  useEffect(() => {
    setActiveChipIds(prev => {
      const stillValid = prev.filter(id =>
        sourceChips.some(c => c.id === id && c.cards.length > 0),
      );
      return stillValid.length === prev.length ? prev : stillValid;
    });
  }, [sourceChips]);

  // Apply parent-supplied seed once, then notify so the parent can
  // null it out. Effect re-runs whenever seed identity changes.
  useEffect(() => {
    if (!seed) return;
    if (seed.query !== undefined) {
      search.setQuery(seed.query);
    }
    if (seed.activeChips !== undefined) {
      setActiveChipIds(seed.activeChips);
    }
    onSeedConsumed?.();
    // Re-focus the input on the next tick so the seeded query is
    // visible AND the cursor is in the right place if the user wants
    // to refine it.
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  // Browse mode: render the catalog when there's no query so users
  // can scroll without searching.
  const browseResults = useMemo(() => browseAllGroups(allCards), [allCards]);

  // When source chips are active, scope the grid to the union of
  // selected chip pools instead of the catalog.
  const sourceResults = useMemo(() => {
    if (activeChipIds.length === 0) return null;
    const pool: CardVariant[] = [];
    for (const id of activeChipIds) {
      const chip = sourceChips.find(c => c.id === id);
      if (chip) pool.push(...chip.cards);
    }
    return browseAllGroups(pool);
  }, [activeChipIds, sourceChips]);

  const baseResults = sourceResults
    ? sourceResults
    : (hasQuery ? search.results : browseResults);

  const filteredResults = useMemo(
    () => applySelectionFilters(
      baseResults,
      filters.selectedSets,
      filters.selectedVariants,
    ),
    [baseResults, filters.selectedSets, filters.selectedVariants],
  );
  // Low-priority render so chrome paints before hundreds of browse tiles.
  const deferredResults = useDeferredValue(filteredResults);

  const handleClearSearch = useCallback(() => {
    search.clearSearch();
  }, [search]);

  const handleDismiss = useCallback(() => {
    search.clearSearch();
    inputRef.current?.blur();
    onDismiss();
  }, [search, onDismiss]);

  // Esc handler — global so it works after focus moves to a tile.
  // Only attached while the overlay is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDismiss();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, handleDismiss]);

  const visibleChips = sourceChips.filter(c => c.cards.length > 0 || c.alwaysVisible);

  // Running summary for the context header — lets the user see "what
  // I've picked so far on this side" without dismissing the overlay.
  const pickedCount = cards.reduce((s, c) => s + c.qty, 0);
  const pickedTotal = cards.reduce((s, c) => {
    const p = adjustPrice(getCardPrice(c.card, priceMode), percentage) ?? 0;
    return s + p * c.qty;
  }, 0);

  return (
    <div
      // Back to fullscreen (`inset-0`). Beta feedback: the top peek
      // from the prior iteration was pitched as a helpful "you're
      // inside a larger flow" cue, but in practice it ate space on
      // mobile without clarifying anything. The header's "Done"
      // button + counterpart context line carry the orientation
      // work on their own.
      className={`fixed inset-0 z-40 bg-space-900 flex flex-col transition-all duration-200 ease-out ${
        open
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
    >
      <div className="shrink-0 pt-3 pb-2 px-4 sm:px-6 max-w-6xl mx-auto w-full relative">
        <div
          className={`absolute left-4 sm:left-6 top-3 bottom-3 w-[3px] rounded-full ${saberBarColors[accentColor]}`}
          aria-hidden
        />
        <div className="pl-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[9px] tracking-[0.25em] text-gray-500 uppercase truncate">
              Adding to
              {counterpartHandle && (
                <span className="normal-case tracking-normal text-gray-400"> · for <span className="text-gold">@{counterpartHandle}</span></span>
              )}
            </div>
            <div className={`swu-display text-base ${hdr.split(' ').pop()}`}>{label}</div>
            {open && pickedCount > 0 && (
              // Gated on `open` — the overlay's DOM stays mounted while
              // closed (for the fade/translate transition), but text
              // queries would still match the hidden "3" here AND a
              // visible qty "3" in the trade panel. Strict-mode page
              // locators would then throw.
              <div className="text-[10px] text-gray-500 mt-0.5">
                Picked so far: <strong className="text-gray-300">{pickedCount}</strong>
                {pickedTotal > 0 && <> · <strong className="text-gray-300">${pickedTotal.toFixed(2)}</strong></>}
              </div>
            )}
          </div>
          <button
            onClick={handleDismiss}
            className={`shrink-0 px-3 py-1.5 rounded-lg font-bold text-xs uppercase tracking-wider transition-colors ${doneButtonColors[accentColor]}`}
            aria-label="Close search"
            title={counterpartHandle ? 'Back to proposal (Esc)' : 'Close (Esc)'}
          >
            Done
          </button>
        </div>
      </div>

      <div className="shrink-0 pb-1 px-4 sm:px-6 max-w-6xl mx-auto w-full">
        <div className="relative">
          <div className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
            {search.isSearching || isLoading ? (
              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={search.query}
            onChange={e => search.setQuery(e.target.value)}
            onFocus={e => e.currentTarget.select()}
            placeholder="Search cards..."
            className={`w-full bg-space-700 text-gray-100 border border-space-600 rounded-lg pl-8 pr-8 py-2 text-base placeholder-gray-500 focus:outline-none focus:ring-1 transition-all ${searchBorder}`}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {search.query && (
            <button
              onClick={handleClearSearch}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Filter summary button — collapses source chips + variant +
          set selectors behind one tap. Beta feedback said the picker
          felt overloaded with multiple rows of controls always on
          screen; the single summary reads as "here's what's filtered
          right now, tap if you want to change it." */}
      <div className="shrink-0 pt-2 pb-1 px-4 sm:px-6 max-w-6xl mx-auto w-full">
        <FilterSummaryButton
          visibleChips={visibleChips}
          activeChipIds={activeChipIds}
          selectedVariants={filters.selectedVariants}
          selectedSets={filters.selectedSets}
          isOpen={filtersOpen}
          onToggle={() => setFiltersOpen(o => !o)}
        />
        {filtersOpen && (
          <div className="mt-2 space-y-2">
            {visibleChips.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] font-bold tracking-[0.15em] uppercase text-gray-500 mr-1">
                  Show
                </span>
                {visibleChips.map(chip => (
                  <SourceChip
                    key={chip.id}
                    active={activeChipIds.includes(chip.id)}
                    onClick={() => setActiveChipIds(prev =>
                      prev.includes(chip.id)
                        ? prev.filter(id => id !== chip.id)
                        : [...prev, chip.id],
                    )}
                    label={chip.label}
                    count={chip.cards.length}
                  />
                ))}
              </div>
            )}
            <SelectionFilterBar filters={filters} />
          </div>
        )}
      </div>

      {/* Grid only mounts when the overlay is actually shown — browse
          mode renders hundreds of tiles, so we don't pay that DOM
          cost while the overlay is hidden behind the trade view. */}
      <div className="flex-1 min-h-0 max-w-6xl mx-auto w-full flex flex-col">
        {open && (
          <SearchResults
            results={deferredResults}
            percentage={percentage}
            priceMode={priceMode}
            onAdd={onAdd}
            onChangeQty={onChangeQty}
            onRemove={onRemove}
            tradeCards={cards}
            isSearching={search.isSearching}
            accentColor={accentColor}
          />
        )}
      </div>

      {/* Bottom Done removed — the Done button is now in the header
          (labeled, colored to match the side accent) so it's the
          single dismiss affordance on mobile and desktop. */}
    </div>
  );
}

/**
 * Collapsed-state summary button for the picker's filter row. Shows
 * a compact "Overlap (3) · Hyperspace · All sets" style summary so
 * users can see current filter state without the row taking up
 * vertical space. Taps toggle the expanded detail surface (source
 * chips + variant + set) below.
 */
function FilterSummaryButton({
  visibleChips,
  activeChipIds,
  selectedVariants,
  selectedSets,
  isOpen,
  onToggle,
}: {
  visibleChips: SourceChipConfig[];
  activeChipIds: readonly string[];
  selectedVariants: readonly string[];
  selectedSets: readonly string[];
  isOpen: boolean;
  onToggle: () => void;
}) {
  const active = visibleChips.filter(c => activeChipIds.includes(c.id));
  const chipPart = active.length === 0
    ? 'All cards'
    : active.length === 1
      ? `${active[0].label}${active[0].cards.length > 0 ? ` (${active[0].cards.length})` : ''}`
      : `${active.length} sources`;
  const variantPart = summarizeSelection(
    selectedVariants,
    'Any variant',
    (v) => variantChipLabel(v as CanonicalVariant),
  );
  const setPart = summarizeSelection(selectedSets, 'All sets', setSummaryLabel);

  const anyActive = activeChipIds.length > 0
    || selectedVariants.length > 0
    || selectedSets.length > 0;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md border text-[11px] transition-colors ${
        anyActive
          ? 'bg-gold/10 border-gold/30 text-gray-200 hover:border-gold/50'
          : 'bg-space-800/60 border-space-700 text-gray-400 hover:border-gray-500'
      }`}
    >
      <FilterIcon className="w-3.5 h-3.5 shrink-0" />
      <span className="flex-1 text-left truncate">
        {chipPart} <span className="text-gray-500">·</span> {variantPart} <span className="text-gray-500">·</span> {setPart}
      </span>
      <svg
        className={`w-3 h-3 shrink-0 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );
}

function FilterIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 4h12M4 8h8M6 12h4" />
    </svg>
  );
}

function SourceChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-colors border ${
        active
          ? 'bg-gold/20 text-gold-bright border-gold/50'
          : 'bg-space-800/60 text-gray-400 border-space-700 hover:text-gray-200 hover:border-gray-500'
      }`}
    >
      <span>{label}</span>
      <span className={`px-1.5 py-px rounded-full text-[10px] font-bold leading-none ${active ? 'bg-gold/30 text-gold-bright' : 'bg-space-700 text-gray-300'}`}>
        {count}
      </span>
    </button>
  );
}
