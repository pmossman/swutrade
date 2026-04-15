import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import type { TradeCard, CardVariant, PriceMode } from '../types';
import { tradeCardKey } from '../types';
import { adjustPrice, cardImageUrl, cardTcgPlayerUrl, getCardPrice, getAltPrice } from '../services/priceService';
import { extractVariantLabel, extractBaseName, variantBadgeColor, variantDisplayLabel } from '../variants';
import { useCardSearch, browseAllGroups } from '../hooks/useCardSearch';
import { useIsMobile } from '../hooks/useMediaQuery';
import { SearchResults } from './SearchResults';
import { SelectionFilterBar } from './SelectionFilterBar';
import type { SelectionFilters } from '../hooks/useSelectionFilters';
import { applySelectionFilters } from '../applySelectionFilters';
import { KebabMenu } from './KebabMenu';
import type { KebabMenuItem } from './KebabMenu';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import type { SharedLists } from '../hooks/useSharedLists';
import { TradeListsSection } from './TradeListsSection';

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
}

function formatPrice(price: number | null): string {
  if (price === null) return 'N/A';
  return `$${price.toFixed(2)}`;
}

// Missing prices silently get treated as $0 in the totals, which can throw
// off a trade by a lot — make them loud at every level (row tint, border,
// icon) so the user can't miss them.
const priceClass = (price: number | null, defaultClass: string) =>
  price === null ? 'text-red-400 font-bold' : defaultClass;

const MissingPriceIcon = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
  </svg>
);

// Adaptive card image — size driven by parent
type ThumbSize = 'xs' | 'sm' | 'md' | 'lg';

function CardThumb({ productId, name, size }: { productId?: string; name: string; size: ThumbSize }) {
  const [errored, setErrored] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const imgSize = size === 'lg' ? 'lg' : 'md';
  const src = cardImageUrl(productId, imgSize);

  // Portrait (standard card) vs landscape (leader card). Leaders detected
  // on image load — flip width/height so the full card shows instead of
  // being crop-cover'd to portrait.
  const sizeClassesPortrait: Record<ThumbSize, string> = {
    xs: 'w-5 h-7 rounded-sm text-[8px]',
    sm: 'w-7 h-10 rounded text-[9px]',
    md: 'w-10 h-14 rounded-md text-[10px]',
    lg: 'w-20 h-28 rounded-lg text-sm',
  };
  const sizeClassesLandscape: Record<ThumbSize, string> = {
    xs: 'w-7 h-5 rounded-sm text-[8px]',
    sm: 'w-10 h-7 rounded text-[9px]',
    md: 'w-14 h-10 rounded-md text-[10px]',
    lg: 'w-28 h-20 rounded-lg text-sm',
  };
  const sizeClass = (isLandscape ? sizeClassesLandscape : sizeClassesPortrait)[size];

  if (!src || errored) {
    return (
      <div className={`${sizeClass} bg-space-600 shrink-0 flex items-center justify-center text-gray-600`}>
        ?
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      onError={() => setErrored(true)}
      onLoad={e => {
        const img = e.currentTarget;
        if (img.naturalWidth > img.naturalHeight) setIsLandscape(true);
      }}
      className={`${sizeClass} object-cover shrink-0 bg-space-600`}
    />
  );
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

const qtyBtnColors: Record<string, string> = {
  emerald: 'text-emerald-400 bg-emerald-900/30 hover:bg-emerald-900/50 active:bg-emerald-900/70',
  blue: 'text-blue-400 bg-blue-900/30 hover:bg-blue-900/50 active:bg-blue-900/70',
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
}: TradeSideProps) {
  const isMobile = useIsMobile();
  const [searchFocused, setSearchFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayInputRef = useRef<HTMLInputElement>(null);

  const allCards = useMemo(() => Object.values(setCards).flat(), [setCards]);

  const search = useCardSearch({ allCards, setFilter: null });
  const hasQuery = search.query.length >= 2;

  // Browse mode: when the user hasn't typed, render the whole catalog
  // (respecting filters). Memoize per-allCards so switching between
  // browse and search doesn't rebuild on every keystroke.
  const browseResults = useMemo(() => browseAllGroups(allCards), [allCards]);

  const filteredResults = useMemo(
    () => applySelectionFilters(
      hasQuery ? search.results : browseResults,
      filters.selectedSets,
      filters.selectedVariants,
    ),
    [hasQuery, search.results, browseResults, filters.selectedSets, filters.selectedVariants],
  );

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
  const qtyBtn = qtyBtnColors[accentColor];
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
      {/* Filter bar — variant + set collapsibles above the results.
          Market/Low lives in the main top bar, not here. */}
      <div className="shrink-0 pt-2 pb-1 px-4 sm:px-6 max-w-6xl mx-auto w-full">
        <SelectionFilterBar filters={filters} />
      </div>

      {/* Lists section rendered ALWAYS (returns null when both lists
          are empty for this side). Bounded max-height so the card
          grid below always gets room — browse mode shows the full
          catalog even without a query. */}
      <div className="shrink-0 max-w-6xl mx-auto w-full px-4 sm:px-6 pt-2 max-h-[35vh] overflow-y-auto">
        <TradeListsSection
          side={accentColor === 'emerald' ? 'offering' : 'receiving'}
          wants={wants}
          available={available}
          sharedLists={sharedLists}
          byFamilyAll={byFamilyAll}
          byProductId={byProductId}
          tradeCards={cards}
          percentage={percentage}
          priceMode={priceMode}
          onAdd={onAdd}
        />
      </div>

      {/* Grid only mounts when the overlay is actually shown — browse
          mode can render hundreds of tiles, so we don't pay that DOM
          cost while the overlay is hidden behind the main trade view. */}
      <div className="flex-1 min-h-0 max-w-6xl mx-auto w-full flex flex-col">
        {showOverlay && <SearchResults
          results={filteredResults}
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
              const unitPrice = adjustPrice(getCardPrice(tc.card, priceMode), percentage);
              const altUnitPrice = adjustPrice(getAltPrice(tc.card, priceMode), percentage);
              const lineTotal = unitPrice !== null ? unitPrice * tc.qty : null;
              const variant = extractVariantLabel(tc.card.name);

              // Market↔Low spread. Computed off raw (unadjusted) prices so
              // the percentage tracks the cards themselves, not the user's
              // negotiation slider. Require BOTH a meaningful ratio and a
              // dollar-gap floor — a $0.30 → $0.20 card is 33% but nobody
              // cares about 10 cents.
              const marketRaw = getCardPrice(tc.card, 'market');
              const lowRaw = getCardPrice(tc.card, 'low');
              const spreadDollar = (marketRaw !== null && lowRaw !== null) ? marketRaw - lowRaw : null;
              const spreadPct = (marketRaw !== null && lowRaw !== null && marketRaw > 0)
                ? (marketRaw - lowRaw) / marketRaw
                : null;
              const spreadHigh = spreadPct !== null && spreadPct >= 0.25 && (spreadDollar ?? 0) >= 0.5;

              const rowPads: Record<ThumbSize, string> = {
                lg: 'px-3 py-3 gap-3',
                md: 'px-2.5 py-1.5 gap-2',
                sm: 'px-2 py-1 gap-1.5',
                xs: 'px-1.5 py-0.5 gap-1.5',
              };
              const isCompact = tSize === 'sm' || tSize === 'xs';
              const isLarge = tSize === 'lg';

              const tcgUrl = cardTcgPlayerUrl(tc.card.productId);
              const missingPrice = unitPrice === null;
              // Loud red border + tinted background when a row has no price —
              // these line items contribute $0 to the total and are easy to
              // gloss over otherwise.
              const rowClasses = missingPrice
                ? `group flex items-center ${rowPads[tSize]} border-l-4 border-red-500 bg-red-950/30`
                : `group flex items-center ${rowPads[tSize]} hover:bg-space-700/30 transition-colors`;

              const spreadBadge = spreadHigh && spreadPct !== null ? (
                <span
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 text-[9px] font-semibold leading-none"
                  title={`Wide spread: Market $${(marketRaw ?? 0).toFixed(2)} vs Low $${(lowRaw ?? 0).toFixed(2)}`}
                >
                  Δ{Math.round(spreadPct * 100)}%
                </span>
              ) : null;

              return (
                <div key={key} className={rowClasses}>
                  <div className="shrink-0">
                    <CardThumb productId={tc.card.productId} name={tc.card.name} size={tSize} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {missingPrice && (
                        <span className="text-red-400 shrink-0" title="No price data">
                          <MissingPriceIcon className={isCompact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
                        </span>
                      )}
                      <span className={`text-gray-100 leading-tight ${isLarge ? 'text-sm font-semibold' : isCompact ? 'text-[11px] truncate' : 'text-xs truncate'}`}>
                        {extractBaseName(tc.card.name)}
                      </span>
                      {(() => {
                        // Show a styled variant pill in place of the
                        // raw "(Hyperspace Foil)" suffix — consistent
                        // with the tile/summary badges.
                        const label = variantDisplayLabel(variant);
                        if (!label) return null;
                        return (
                          <span className={`text-[9px] leading-none px-1.5 py-0.5 rounded font-bold uppercase tracking-wide shrink-0 ${variantBadgeColor(variant)}`}>
                            {label}
                          </span>
                        );
                      })()}
                      {isLarge && spreadBadge}
                    </div>
                    {!isCompact && !isLarge && (
                      <div className="flex items-center gap-1.5 flex-wrap leading-tight mt-0.5 text-[10px] text-gray-500">
                        {spreadBadge}
                        <span>
                          <span className="text-gray-400">{priceMode === 'market' ? 'Mkt' : 'Low'}</span>{' '}
                          <span className={priceClass(unitPrice, '')}>{formatPrice(unitPrice)}</span> ea
                          {altUnitPrice !== null && (
                            <span className="text-gray-600 ml-1">
                              <span className="text-gray-600">{priceMode === 'market' ? 'Low' : 'Mkt'}</span> {formatPrice(altUnitPrice)}
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                    {isLarge && (
                      <div className="mt-1 flex items-center gap-2 text-xs">
                        <span className="flex items-baseline gap-1">
                          <span className="text-[9px] uppercase tracking-wide text-gray-500">{priceMode === 'market' ? 'Mkt' : 'Low'}</span>
                          <span className={`tabular-nums ${priceClass(unitPrice, 'text-gray-400')}`}>
                            {formatPrice(unitPrice)}
                          </span>
                        </span>
                        {altUnitPrice !== null && (
                          <span className="flex items-baseline gap-1 text-gray-600">
                            <span className="text-[9px] uppercase tracking-wide">{priceMode === 'market' ? 'Low' : 'Mkt'}</span>
                            <span className="tabular-nums">{formatPrice(altUnitPrice)}</span>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Secondary actions collapsed behind a kebab to keep
                      the row scannable. Qty controls stay primary. */}
                  {(() => {
                    const menuItems: KebabMenuItem[] = [];
                    if (tcgUrl) {
                      menuItems.push({
                        label: 'View on TCGPlayer',
                        href: tcgUrl,
                        icon: (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        ),
                      });
                    }
                    menuItems.push({
                      label: 'Swap variant',
                      onClick: () => handleReplace(tc.card),
                      icon: (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 3l4 4m0 0l-4 4m4-4H4m4 14l-4-4m0 0l4-4m-4 4h16" />
                        </svg>
                      ),
                    });
                    return (
                      <div className="shrink-0">
                        <KebabMenu items={menuItems} size={isCompact ? 'xs' : isLarge ? 'md' : 'sm'} />
                      </div>
                    );
                  })()}
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => tc.qty <= 1 ? onRemove(key) : onChangeQty(key, -1)}
                      className={`${isCompact ? 'w-5 h-5 text-[10px]' : tSize === 'lg' ? 'w-8 h-8 text-sm' : 'w-6 h-6 text-xs'} rounded flex items-center justify-center font-bold transition-colors active:scale-90 ${tc.qty <= 1 ? 'text-red-400 bg-red-900/30 hover:bg-red-900/50' : qtyBtn}`}
                      aria-label={tc.qty <= 1 ? 'Remove' : 'Decrease quantity'}
                    >
                      {tc.qty <= 1 ? '×' : '−'}
                    </button>
                    <span className={`${isCompact ? 'w-4 text-[10px]' : tSize === 'lg' ? 'w-6 text-sm' : 'w-5 text-xs'} text-center font-bold text-gray-200 tabular-nums`}>
                      {tc.qty}
                    </span>
                    <button
                      onClick={() => onChangeQty(key, 1)}
                      className={`${isCompact ? 'w-5 h-5 text-[10px]' : tSize === 'lg' ? 'w-8 h-8 text-sm' : 'w-6 h-6 text-xs'} rounded flex items-center justify-center font-bold transition-colors active:scale-90 ${qtyBtn}`}
                      aria-label="Increase quantity"
                    >
                      +
                    </button>
                  </div>
                  <span className={`${isCompact ? 'text-[10px] w-11' : isLarge ? 'text-sm w-16' : 'text-xs w-14'} font-semibold tabular-nums shrink-0 text-right ${priceClass(lineTotal, 'text-gold')}`}>
                    {formatPrice(lineTotal)}
                  </span>
                </div>
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
