import { useState, useMemo, useRef, useCallback } from 'react';
import type { TradeCard, CardVariant, PriceMode } from '../types';
import { SETS, tradeCardKey } from '../types';
import { adjustPrice, extractVariantLabel, extractBaseName, cardImageUrl, getCardPrice, getAltPrice } from '../services/priceService';
import { useCardSearch } from '../hooks/useCardSearch';
import { SearchResults } from './SearchResults';

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
  setFilter: string | null;
  isLoading: boolean;
  onLoadAllSets: () => void;
}

function formatPrice(price: number | null): string {
  if (price === null) return 'N/A';
  return `$${price.toFixed(2)}`;
}

// Adaptive card image — size driven by parent
type ThumbSize = 'xs' | 'sm' | 'md' | 'lg';

function CardThumb({ productId, name, size }: { productId?: string; name: string; size: ThumbSize }) {
  const [errored, setErrored] = useState(false);
  const imgSize = size === 'lg' ? 'lg' : 'md';
  const src = cardImageUrl(productId, imgSize);

  const sizeClasses: Record<ThumbSize, string> = {
    xs: 'w-5 h-7 rounded-sm text-[8px]',
    sm: 'w-7 h-10 rounded text-[9px]',
    md: 'w-10 h-14 rounded-md text-[10px]',
    lg: 'w-20 h-28 rounded-lg text-sm',
  };

  if (!src || errored) {
    return (
      <div className={`${sizeClasses[size]} bg-space-600 shrink-0 flex items-center justify-center text-gray-600`}>
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
      className={`${sizeClasses[size]} object-cover shrink-0 bg-space-600`}
    />
  );
}

const headerColors: Record<string, string> = {
  emerald: 'border-emerald-500/30 text-emerald-400',
  blue: 'border-blue-500/30 text-blue-400',
};

const searchBorderColors: Record<string, string> = {
  emerald: 'focus:border-emerald-500/50 focus:ring-emerald-500/20',
  blue: 'focus:border-blue-500/50 focus:ring-blue-500/20',
};

const qtyBtnColors: Record<string, string> = {
  emerald: 'text-emerald-400 bg-emerald-900/30 hover:bg-emerald-900/50 active:bg-emerald-900/70',
  blue: 'text-blue-400 bg-blue-900/30 hover:bg-blue-900/50 active:bg-blue-900/70',
};

// Pick thumbnail size based on total card entries
function thumbSize(cardCount: number): ThumbSize {
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
  setFilter,
  isLoading,
  onLoadAllSets,
}: TradeSideProps) {
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayInputRef = useRef<HTMLInputElement>(null);

  const effectiveFilter = searchExpanded ? null : setFilter;

  const allCards = useMemo(() => {
    if (effectiveFilter) {
      return setCards[effectiveFilter] || [];
    }
    return Object.values(setCards).flat();
  }, [setCards, effectiveFilter]);

  const search = useCardSearch({ allCards, setFilter: effectiveFilter });

  const handleExpandSearch = () => {
    setSearchExpanded(true);
    onLoadAllSets();
  };

  const handleClearSearch = () => {
    search.clearSearch();
    setSearchExpanded(false);
    setSearchFocused(false);
  };

  const handleDismissSearch = useCallback(() => {
    search.clearSearch();
    setSearchExpanded(false);
    setSearchFocused(false);
    inputRef.current?.blur();
    overlayInputRef.current?.blur();
  }, [search]);

  const handleCardTap = useCallback((card: CardVariant) => {
    const baseName = extractBaseName(card.name);
    setSearchExpanded(true);
    onLoadAllSets();
    search.setQuery(baseName);
  }, [search, onLoadAllSets]);

  const setFilterLabel = setFilter
    ? SETS.find(s => s.slug === setFilter)?.code || null
    : null;

  const total = cards.reduce((sum, tc) => {
    const adj = adjustPrice(getCardPrice(tc.card, priceMode), percentage);
    return sum + (adj ?? 0) * tc.qty;
  }, 0);

  const hasSearchResults = search.query.length >= 2;
  const showOverlay = searchFocused || hasSearchResults;

  const hdr = headerColors[accentColor];
  const searchBorder = searchBorderColors[accentColor];
  const qtyBtn = qtyBtnColors[accentColor];
  const tSize = thumbSize(cards.length);

  return (
    <>
    {/* Search overlay — covers viewport when actively searching */}
    <div
      className={`fixed inset-0 z-40 bg-space-900/95 flex flex-col transition-all duration-200 ease-out ${
        showOverlay
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
    >
      <div className="shrink-0 px-3 pt-3 pb-1">
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
            placeholder="Search cards..."
            className={`w-full bg-space-700 text-gray-100 border border-space-600 rounded-lg pl-8 pr-8 py-1.5 text-base placeholder-gray-500 focus:outline-none focus:ring-1 transition-all ${searchBorder}`}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            onClick={handleClearSearch}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className={`text-[11px] font-semibold ${hdr.split(' ').pop()}`}>Adding to: {label}</span>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
        {!hasSearchResults && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            Type a card name to search
          </div>
        )}
        <SearchResults
          results={search.results}
          percentage={percentage}
          priceMode={priceMode}
          onAdd={onAdd}
          onChangeQty={onChangeQty}
          onRemove={onRemove}
          tradeCards={cards}
          isSearching={search.isSearching}
          query={search.query}
          accentColor={accentColor}
          isExpanded={searchExpanded}
          setFilterLabel={setFilterLabel}
          onExpandSearch={handleExpandSearch}
        />
      </div>
      {/* Done button */}
      <div className="shrink-0 px-3 pb-3 pt-1">
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
    <div className={`bg-space-800 rounded-xl border ${borderColor} overflow-hidden flex flex-col min-h-0`}>
      {/* Header */}
      <div className={`flex items-center justify-between px-3 py-2 border-b border-space-600 shrink-0 ${hdr}`}>
        <span className="font-semibold text-sm uppercase tracking-wide">{label}</span>
        <span className="font-bold tabular-nums">{formatPrice(total)}</span>
      </div>

      {/* Search input */}
      <div className="px-2.5 pt-2 pb-1 shrink-0">
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
            type="text"
            value={search.query}
            onChange={e => search.setQuery(e.target.value)}
            onFocus={() => {
              setSearchFocused(true);
              // Move focus to the overlay input after it renders
              setTimeout(() => overlayInputRef.current?.focus(), 50);
            }}
            placeholder={searchExpanded ? 'Search all sets...' : `Add cards${setFilterLabel ? ` (${setFilterLabel})` : ''}...`}
            className={`w-full bg-space-700 text-gray-100 border border-space-600 rounded-lg pl-8 pr-8 py-1.5 text-base placeholder-gray-500 focus:outline-none focus:ring-1 transition-all ${searchBorder}`}
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

      {/* Card list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {cards.length === 0 ? (
          <div className="h-full flex items-center justify-center px-3 text-gray-600 text-xs">
            Search above to add cards
          </div>
        ) : (
          <div className="divide-y divide-space-700">
            {cards.map(tc => {
              const key = tradeCardKey(tc.card);
              const unitPrice = adjustPrice(getCardPrice(tc.card, priceMode), percentage);
              const altUnitPrice = adjustPrice(getAltPrice(tc.card, priceMode), percentage);
              const lineTotal = unitPrice !== null ? unitPrice * tc.qty : null;
              const variant = extractVariantLabel(tc.card.name);

              const rowPads: Record<ThumbSize, string> = {
                lg: 'px-3 py-3 gap-3',
                md: 'px-2.5 py-1.5 gap-2',
                sm: 'px-2 py-1 gap-1.5',
                xs: 'px-1.5 py-0.5 gap-1.5',
              };
              const isCompact = tSize === 'sm' || tSize === 'xs';

              return (
                <div key={key} className={`flex items-center ${rowPads[tSize]}`}>
                  <button
                    onClick={() => handleCardTap(tc.card)}
                    className="shrink-0"
                    title="Tap to find variants"
                  >
                    <CardThumb productId={tc.card.productId} name={tc.card.name} size={tSize} />
                  </button>
                  <button
                    onClick={() => handleCardTap(tc.card)}
                    className="min-w-0 flex-1 text-left"
                    title="Tap to find variants"
                  >
                    <div className="flex items-center gap-1">
                      <span className={`text-gray-200 truncate leading-tight ${tSize === 'lg' ? 'text-sm font-medium' : isCompact ? 'text-[11px]' : 'text-xs'}`}>
                        {tc.card.name}
                      </span>
                    </div>
                    {!isCompact && (
                      <div className={`text-gray-500 leading-tight ${tSize === 'lg' ? 'text-xs mt-0.5' : 'text-[10px]'}`}>
                        {variant} &middot;{' '}
                        <span className="text-gray-400">{priceMode === 'market' ? 'Mkt' : 'Low'}</span> {formatPrice(unitPrice)} ea
                        {altUnitPrice !== null && (
                          <span className="text-gray-600 ml-1">
                            <span className="text-gray-600">{priceMode === 'market' ? 'Low' : 'Mkt'}</span> {formatPrice(altUnitPrice)}
                          </span>
                        )}
                      </div>
                    )}
                    {tSize === 'lg' && tc.qty > 1 && (
                      <div className="text-xs text-gold font-semibold mt-0.5">
                        {tc.qty} x = {formatPrice(lineTotal)}
                      </div>
                    )}
                  </button>
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
                  {tSize !== 'lg' && (
                    <span className={`${isCompact ? 'text-[10px] w-11' : 'text-xs w-14'} font-semibold text-gold tabular-nums shrink-0 text-right`}>
                      {formatPrice(lineTotal)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
    </>
  );
}
