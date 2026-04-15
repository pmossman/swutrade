import { useState, useMemo, useRef, useCallback, useEffect, useDeferredValue } from 'react';
import type { TradeCard, CardVariant, PriceMode } from '../types';
import { tradeCardKey } from '../types';
import { adjustPrice, formatPrice, getCardPrice } from '../services/priceService';
import { extractBaseName } from '../variants';
import { useCardSearch, browseAllGroups } from '../hooks/useCardSearch';
import { bestMatchForWant, matchesRestriction } from '../listMatching';
import type { WantsItem } from '../persistence';
import { useIsMobile } from '../hooks/useMediaQuery';
import { SearchResults } from './SearchResults';
import { SelectionFilterBar } from './SelectionFilterBar';
import type { SelectionFilters } from '../hooks/useSelectionFilters';
import { applySelectionFilters } from '../applySelectionFilters';
import { TradeRow, type ThumbSize } from './TradeRow';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import type { SharedLists } from '../hooks/useSharedLists';

interface TradeSideProps {
  label: string;
  cards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
  onAdd: (card: CardVariant) => void;
  onRemove: (key: string) => void;
  onChangeQty: (key: string, delta: number) => void;
  accentColor: 'emerald' | 'blue';
  borderColor: string;
  setCards: Record<string, CardVariant[]>;
  isLoading: boolean;
  onLoadAllSets: () => void;
  // Shared filter state. Lifted to App so both trade sides stay in sync.
  filters: SelectionFilters;
  // Personal-source pickers in the search overlay's empty state pull
  // from these. Offering side surfaces Available; Receiving surfaces
  // Wants. byFamilyAll / byProductId are the same indexes the Lists
  // Drawer uses; lifted to App so both surfaces stay in sync.
  wants: WantsApi;
  available: AvailableApi;
  sharedLists: SharedLists | null;
  byFamilyAll: Map<string, CardVariant[]>;
  byProductId: Map<string, CardVariant>;
  /** When true, the card list collapses and the header shrinks to show
   *  just the label + count + total, with a chevron to re-expand. */
  collapsed: boolean;
  /** Only provided on mobile — desktop layout shows both panels side
   *  by side so collapsing offers no space win. */
  onToggleCollapse?: () => void;
  /** Optional explicit flex-basis percentage (0-1). When set, overrides
   *  the default auto-sizing — used by the mobile panel divider. */
  flexBasis?: number;
  /** One-shot signal from the shared-list landing: auto-open the
   *  search overlay with the "From the shared link" section
   *  expanded. Consumed on mount. */
  autoOpenSharedLink?: boolean;
  onConsumeAutoOpen?: () => void;
}

const headerColors: Record<string, string> = {
  emerald: 'border-emerald-500/30 text-emerald-300',
  blue: 'border-blue-500/30 text-blue-300',
};

// Vertical "saber bar" on the left edge of each panel — identifies the side
// at a glance. Colored from bright core → muted tail with a soft glow,
// mimicking a lightsaber blade.
const saberBarColors: Record<string, string> = {
  emerald: 'bg-gradient-to-b from-emerald-300 via-emerald-500 to-emerald-700 shadow-[0_0_12px_rgba(52,211,153,0.55)]',
  blue: 'bg-gradient-to-b from-blue-300 via-blue-500 to-blue-700 shadow-[0_0_12px_rgba(96,165,250,0.55)]',
};

const searchBorderColors: Record<string, string> = {
  emerald: 'focus:border-emerald-500/50 focus:ring-emerald-500/20',
  blue: 'focus:border-blue-500/50 focus:ring-blue-500/20',
};

// Collapse chevron — colored to match the side accent so it reads as
// part of the panel chrome, not a generic system control.
const chevronColors: Record<string, string> = {
  emerald: 'text-emerald-400/80',
  blue: 'text-blue-400/80',
};

// Pick thumbnail size based on total card entries. On mobile we cap
// at `md` since even a single card at `lg` eats most of the viewport
// and doesn't leave room for the other panel.
function thumbSize(cardCount: number, isMobile: boolean): ThumbSize {
  if (isMobile) {
    if (cardCount <= 4) return 'md';
    if (cardCount <= 10) return 'sm';
    return 'xs';
  }
  if (cardCount <= 2) return 'lg';
  if (cardCount <= 4) return 'md';
  if (cardCount <= 8) return 'sm';
  return 'xs';
}

export function TradeSide({
  label,
  cards,
  percentage,
  priceMode,
  onAdd,
  onRemove,
  onChangeQty,
  accentColor,
  borderColor,
  setCards,
  isLoading,
  onLoadAllSets,
  wants,
  available,
  sharedLists,
  byFamilyAll,
  byProductId,
  filters,
  collapsed,
  onToggleCollapse,
  flexBasis,
  autoOpenSharedLink,
  onConsumeAutoOpen,
}: TradeSideProps) {
  const isMobile = useIsMobile();
  const isOffering = accentColor === 'emerald';
  const [searchFocused, setSearchFocused] = useState(false);
  // Source toggles: restrict the picker grid to a personal/shared
  // subset instead of the full catalog. Mutually additive (both on
  // unions the two sets); user's Variant/Set filters still narrow
  // whatever source is active.
  const [sourceMine, setSourceMine] = useState(false);
  const [sourceTheirs, setSourceTheirs] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayInputRef = useRef<HTMLInputElement>(null);

  const allCards = useMemo(() => Object.values(setCards).flat(), [setCards]);

  const search = useCardSearch({ allCards, setFilter: null });
  const hasQuery = search.query.length >= 2;

  // Browse mode: when the user hasn't typed, render the whole catalog
  // (respecting filters). Memoize per-allCards so switching between
  // browse and search doesn't rebuild on every keystroke.
  const browseResults = useMemo(() => browseAllGroups(allCards), [allCards]);

  // Source-chip counts (shown in chip labels). Qty-aware: only
  // counts items still pending after what's already been added to
  // this side of the trade, matching the behavior users expect from
  // a "to-do list".
  const { mineCount, theirsCount, mineCards, theirsCards } = useMemo(() => {
    const mine: CardVariant[] = [];
    const theirs: CardVariant[] = [];
    if (isOffering) {
      for (const item of available.items) {
        const card = byProductId.get(item.productId);
        if (!card) continue;
        const inTrade = cards.reduce((s, tc) => tc.card.productId === item.productId ? s + tc.qty : s, 0);
        if (item.qty - inTrade > 0) mine.push(card);
      }
      if (sharedLists) {
        for (const w of sharedLists.wants) {
          const candidates = byFamilyAll.get(w.familyId) ?? [];
          if (candidates.length === 0) continue;
          const synth: WantsItem = { ...w, id: '_', addedAt: 0 };
          const match = bestMatchForWant(synth, candidates, priceMode);
          if (!match) continue;
          const fids = new Set(candidates.map(c => c.productId).filter((p): p is string => !!p));
          const inTrade = cards.reduce((s, tc) => {
            if (!tc.card.productId || !fids.has(tc.card.productId)) return s;
            if (!matchesRestriction(tc.card, w.restriction)) return s;
            return s + tc.qty;
          }, 0);
          if (w.qty - inTrade > 0) theirs.push(match);
        }
      }
    } else {
      // Receiving side
      for (const item of wants.items) {
        const candidates = byFamilyAll.get(item.familyId) ?? [];
        if (candidates.length === 0) continue;
        const match = bestMatchForWant(item, candidates, priceMode);
        if (!match) continue;
        const fids = new Set(candidates.map(c => c.productId).filter((p): p is string => !!p));
        const inTrade = cards.reduce((s, tc) => {
          if (!tc.card.productId || !fids.has(tc.card.productId)) return s;
          if (!matchesRestriction(tc.card, item.restriction)) return s;
          return s + tc.qty;
        }, 0);
        if (item.qty - inTrade > 0) mine.push(match);
      }
      if (sharedLists) {
        for (const a of sharedLists.available) {
          const card = byProductId.get(a.productId);
          if (!card) continue;
          const inTrade = cards.reduce((s, tc) => tc.card.productId === a.productId ? s + tc.qty : s, 0);
          if (a.qty - inTrade > 0) theirs.push(card);
        }
      }
    }
    return { mineCount: mine.length, theirsCount: theirs.length, mineCards: mine, theirsCards: theirs };
  }, [isOffering, available.items, wants.items, sharedLists, byFamilyAll, byProductId, cards, priceMode]);

  // If a source chip becomes empty (e.g. user adds the last card to
  // the trade), auto-deactivate it so the grid doesn't show "No
  // cards match your filters" inside an active filter.
  useEffect(() => {
    if (sourceMine && mineCount === 0) setSourceMine(false);
  }, [sourceMine, mineCount]);
  useEffect(() => {
    if (sourceTheirs && theirsCount === 0) setSourceTheirs(false);
  }, [sourceTheirs, theirsCount]);

  // Build source-derived SetSearchGroups when either source chip is
  // active. Uses browseAllGroups to lay them out with consistent set
  // ordering / headers, just against a subset of the catalog instead
  // of the whole thing.
  const sourceResults = useMemo(() => {
    if (!sourceMine && !sourceTheirs) return null;
    const pool: CardVariant[] = [];
    if (sourceMine) pool.push(...mineCards);
    if (sourceTheirs) pool.push(...theirsCards);
    return browseAllGroups(pool);
  }, [sourceMine, sourceTheirs, mineCards, theirsCards]);

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
  // Low-priority render so the overlay chrome can paint before hundreds
  // of browse tiles commit.
  const deferredResults = useDeferredValue(filteredResults);

  const handleClearSearch = () => {
    search.clearSearch();
    setSearchFocused(false);
  };

  const handleDismissSearch = useCallback(() => {
    search.clearSearch();
    setSearchFocused(false);
    inputRef.current?.blur();
    overlayInputRef.current?.blur();
  }, [search]);

  const handleReplace = useCallback((card: CardVariant) => {
    const baseName = extractBaseName(card.name);
    setSearchFocused(true);
    onLoadAllSets();
    search.setQuery(baseName);
    setTimeout(() => overlayInputRef.current?.focus(), 50);
  }, [search, onLoadAllSets]);

  // Shared-list handoff: when App sets autoOpenSharedLink, this side
  // auto-opens its search overlay AND activates the "they want" source
  // chip, dropping the user straight onto the sender's cards.
  useEffect(() => {
    if (!autoOpenSharedLink) return;
    setSearchFocused(true);
    setSourceTheirs(true);
    onConsumeAutoOpen?.();
  }, [autoOpenSharedLink, onConsumeAutoOpen]);

  // Escape dismisses the overlay. Listening globally (not on the input)
  // so it keeps working after focus moves to a tile/button from a click.
  useEffect(() => {
    if (!searchFocused && !search.query) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDismissSearch();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchFocused, search.query, handleDismissSearch]);

  // No top-bar set filter anymore — the search overlay owns scoping
  // via its All/Main/Promo toggle and per-set hide chips.
  const setFilterLabel = null;

  const total = cards.reduce((sum, tc) => {
    const adj = adjustPrice(getCardPrice(tc.card, priceMode), percentage);
    return sum + (adj ?? 0) * tc.qty;
  }, 0);

  const hasSearchResults = search.query.length >= 2;
  const showOverlay = searchFocused || hasSearchResults;

  const hdr = headerColors[accentColor];
  const searchBorder = searchBorderColors[accentColor];
  const tSize = thumbSize(cards.length, isMobile);

  return (
    <>
    {/* Search overlay — covers viewport when actively searching. Fully
        opaque so the main view's cards can't bleed through any
        transparent gap between chrome and scroll content. */}
    <div
      className={`fixed inset-0 z-40 bg-space-900 flex flex-col transition-all duration-200 ease-out ${
        showOverlay
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
    >
      {/* Side-ID header — saber bar + swu-display label. Market/Low
          now lives in the controls strip below, with the other
          scope/filter controls, matching the main view layout. */}
      <div className="shrink-0 pt-3 pb-2 px-4 sm:px-6 max-w-6xl mx-auto w-full relative">
        <div className={`absolute left-4 sm:left-6 top-3 bottom-3 w-[3px] rounded-full ${saberBarColors[accentColor]}`} aria-hidden />
        <div className="pl-3 flex items-center justify-between">
          <div>
            <div className="text-[9px] tracking-[0.25em] text-gray-500 uppercase">Adding to</div>
            <div className={`swu-display text-base ${hdr.split(' ').pop()}`}>{label}</div>
          </div>
          <button
            onClick={handleDismissSearch}
            className="text-gray-400 hover:text-gray-200 transition-colors p-1.5"
            aria-label="Close search"
            title="Close (Esc)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
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
            ref={overlayInputRef}
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
      {/* Source + variant/set filters stacked. Source chips narrow
          the grid to a personal or shared list (replacing the
          separate "From your X" / "From the shared link" sections
          that used to eat screen space above the grid). */}
      <div className="shrink-0 pt-2 pb-1 px-4 sm:px-6 max-w-6xl mx-auto w-full space-y-2">
        {(mineCount > 0 || theirsCount > 0) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] font-bold tracking-[0.15em] uppercase text-gray-500 mr-1">
              Show
            </span>
            {mineCount > 0 && (
              <SourceChip
                active={sourceMine}
                onClick={() => setSourceMine(v => !v)}
                label={isOffering ? 'My available' : 'My wants'}
                count={mineCount}
              />
            )}
            {theirsCount > 0 && (
              <SourceChip
                active={sourceTheirs}
                onClick={() => setSourceTheirs(v => !v)}
                label={isOffering ? 'They want' : 'They have'}
                count={theirsCount}
              />
            )}
          </div>
        )}
        <SelectionFilterBar filters={filters} />
      </div>

      {/* Grid only mounts when the overlay is actually shown — browse
          mode can render hundreds of tiles, so we don't pay that DOM
          cost while the overlay is hidden behind the main trade view. */}
      <div className="flex-1 min-h-0 max-w-6xl mx-auto w-full flex flex-col">
        {showOverlay && <SearchResults
          results={deferredResults}
          percentage={percentage}
          priceMode={priceMode}
          onAdd={onAdd}
          onChangeQty={onChangeQty}
          onRemove={onRemove}
          tradeCards={cards}
          isSearching={search.isSearching}
          accentColor={accentColor}
        />}
      </div>
      {/* Touch-only "Done" pill. Desktop users close via the X in the header
          or Escape — tiles are the primary action, so there's no need for
          a CTA at the bottom competing with them. */}
      <div className="shrink-0 px-3 pb-3 pt-1 touch-only">
        <button
          onClick={handleDismissSearch}
          className={`w-full py-2.5 rounded-lg font-semibold text-sm transition-colors ${
            accentColor === 'blue'
              ? 'bg-blue-600 hover:bg-blue-500 text-white'
              : 'bg-emerald-600 hover:bg-emerald-500 text-white'
          }`}
        >
          Done
        </button>
      </div>
    </div>
    <div
      className={`relative bg-space-800 rounded-xl border ${borderColor} overflow-hidden flex flex-col ${collapsed ? 'flex-none' : 'min-h-0'} ${collapsed || flexBasis !== undefined ? '' : 'flex-auto'}`}
      style={!collapsed && flexBasis !== undefined ? { flex: `0 1 ${flexBasis * 100}%` } : undefined}
    >
      {/* Saber-bar side accent */}
      <div className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full ${saberBarColors[accentColor]}`} aria-hidden />
      {/* Header — entire row toggles collapse on tap when collapse is
          available (mobile). The chevron is just a visual indicator,
          colored to match the side's accent so it reads as part of the
          panel rather than a generic gray button. */}
      {(() => {
        const headerContent = (
          <>
            {onToggleCollapse && (
              <span className={`shrink-0 flex items-center justify-center w-5 h-5 ${chevronColors[accentColor]}`} aria-hidden>
                <svg
                  className={`w-4 h-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </span>
            )}
            <span className="swu-display text-xs sm:text-sm">{label}</span>
            {cards.length > 0 && (
              <span className="text-[11px] tabular-nums text-gray-400 font-medium">
                · {cards.length} card{cards.length === 1 ? '' : 's'}
              </span>
            )}
            <span className="flex-1" aria-hidden />
            <span className="flex items-baseline gap-1">
              <span className="text-[9px] uppercase tracking-widest text-gray-500 font-semibold">Total</span>
              <span className="font-bold tabular-nums text-gray-100">{formatPrice(total)}</span>
            </span>
          </>
        );
        const headerClass = `flex items-center gap-2 px-4 py-1.5 ${collapsed ? '' : 'border-b border-space-600'} shrink-0 ${hdr}`;
        return onToggleCollapse ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
            aria-expanded={!collapsed}
            className={`${headerClass} w-full text-left hover:bg-white/[0.02] active:bg-white/[0.04] transition-colors`}
          >
            {headerContent}
          </button>
        ) : (
          <div className={headerClass}>{headerContent}</div>
        );
      })()}

      {/* Card list sits above the sticky Add Card footer below. */}
      <div className={`flex-1 min-h-0 overflow-y-auto flex flex-col ${collapsed ? 'hidden' : ''}`}>
        {cards.length === 0 ? (
          <AddCardsTile
            label={label}
            accentColor={accentColor}
            onOpen={() => {
              setSearchFocused(true);
              setTimeout(() => overlayInputRef.current?.focus(), 50);
            }}
            setFilterLabel={setFilterLabel}
          />
        ) : (
          <div className="divide-y divide-space-700">
            {cards.map(tc => {
              const key = tradeCardKey(tc.card);
              return (
                <TradeRow
                  key={key}
                  card={tc.card}
                  qty={tc.qty}
                  percentage={percentage}
                  priceMode={priceMode}
                  size={tSize}
                  accentColor={accentColor}
                  onChangeQty={delta => onChangeQty(key, delta)}
                  onRemove={() => onRemove(key)}
                  onReplace={() => handleReplace(tc.card)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Sticky Add Card footer — reads as the natural "next step" after
          the card list. Hidden when collapsed (nothing to append to) or
          when empty (AddCardsTile above is already the CTA). */}
      {!collapsed && cards.length > 0 && (
        <button
          type="button"
          onClick={() => {
            setSearchFocused(true);
            setTimeout(() => overlayInputRef.current?.focus(), 50);
          }}
          className={`flex items-center justify-center gap-1.5 py-1.5 border-t border-space-600 text-xs font-semibold transition-colors shrink-0 ${
            accentColor === 'blue'
              ? 'bg-blue-900/30 hover:bg-blue-800/50 text-blue-200'
              : 'bg-emerald-900/30 hover:bg-emerald-800/50 text-emerald-200'
          }`}
          aria-label={`Add cards to ${label}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add card
        </button>
      )}
    </div>
    </>
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

// Add-cards affordance that sits at the end of the card list. When the
// panel is empty it fills the space as a primary CTA. When the panel
// has cards, it's a compact dashed "tail" row that reads as the next
// place to add — like a "+ new row" button in a spreadsheet.
function AddCardsTile({
  label,
  accentColor,
  onOpen,
  setFilterLabel,
}: {
  label: string;
  accentColor: 'emerald' | 'blue';
  onOpen: () => void;
  setFilterLabel: string | null;
}) {
  const accentText = accentColor === 'emerald' ? 'text-emerald-300' : 'text-blue-300';
  const accentHoverBorder = accentColor === 'emerald' ? 'hover:border-emerald-500/50' : 'hover:border-blue-500/50';
  const accentHoverBg = accentColor === 'emerald' ? 'hover:bg-emerald-950/20' : 'hover:bg-blue-950/20';
  const accentIcon = accentColor === 'emerald' ? 'group-hover:text-emerald-300' : 'group-hover:text-blue-300';

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex-1 m-3 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-space-700 ${accentHoverBorder} ${accentHoverBg} text-gray-500 transition-colors cursor-pointer px-4 py-8`}
    >
      <svg className={`w-8 h-8 text-space-600 ${accentIcon} transition-colors`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
      </svg>
      <div className="text-center">
        <div className={`text-sm font-semibold ${accentText}`}>Add cards to {label}</div>
        {setFilterLabel && (
          <div className="text-[11px] text-gray-600 mt-0.5">Filtered to {setFilterLabel}</div>
        )}
      </div>
    </button>
  );
}
