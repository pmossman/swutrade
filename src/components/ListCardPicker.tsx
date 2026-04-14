import { useMemo, useRef, useEffect, useState } from 'react';
import type { CardVariant, PriceMode } from '../types';
import { SETS } from '../types';
import { useCardSearch, type SetSearchGroup } from '../hooks/useCardSearch';
import type { useSearchFilters } from '../hooks/useVariantFilter';
import {
  cardImageUrl,
  adjustPrice,
  getCardPrice,
} from '../services/priceService';
import { extractVariantLabel, variantBadgeColor, variantDisplayLabel } from '../variants';
import { CardResultsGrid } from './CardResultsGrid';
import { SearchControls } from './SearchControls';

const promoSlugs = new Set(SETS.filter(s => s.category === 'promo').map(s => s.slug));

interface ListCardPickerProps {
  allCards: CardVariant[];
  filters: ReturnType<typeof useSearchFilters>;
  percentage: number;
  priceMode: PriceMode;
  onPriceModeChange: (mode: PriceMode) => void;
  title: string;
  onPick: (card: CardVariant) => void;
  onClose: () => void;
}

function relevantSetsForControls(results: SetSearchGroup[], scope: 'all' | 'main' | 'promo'): Map<string, string> {
  const map = new Map<string, string>();
  for (const sg of results) {
    if (scope === 'main' && promoSlugs.has(sg.setSlug)) continue;
    if (scope === 'promo' && !promoSlugs.has(sg.setSlug)) continue;
    if (sg.groups.length > 0) map.set(sg.setSlug, sg.setCode);
  }
  return map;
}

function countSets(results: SetSearchGroup[], which: 'main' | 'promo'): number {
  let n = 0;
  for (const sg of results) {
    const isPromo = promoSlugs.has(sg.setSlug);
    if (which === 'main' && !isPromo) n += 1;
    else if (which === 'promo' && isPromo) n += 1;
  }
  return n;
}

/**
 * Embedded card-search surface for the Lists drawer. Reuses the same
 * SearchControls + CardResultsGrid as the main trade search so filter
 * preferences and set-grouped results stay consistent across the app.
 * Presented as the drawer content when the user taps "Add Card".
 */
export function ListCardPicker({
  allCards,
  filters,
  percentage,
  priceMode,
  onPriceModeChange,
  title,
  onPick,
  onClose,
}: ListCardPickerProps) {
  const { query, setQuery, results, isSearching } = useCardSearch({
    allCards,
    setFilter: null,
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const hasResults = query.length >= 2;

  const relevantSets = useMemo(
    () => relevantSetsForControls(results, filters.scope),
    [results, filters.scope],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-space-800 shrink-0">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="shrink-0 text-gray-500 hover:text-gray-200 transition-colors p-1 -ml-1"
        >
          <BackIcon className="w-4 h-4" />
        </button>
        <span className="text-[11px] font-bold tracking-[0.1em] uppercase text-gray-400">
          {title}
        </span>
      </div>

      <div className="px-3 pt-2 shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search cards..."
          className="w-full px-3 py-2 rounded-lg bg-space-800 border border-space-700 focus:border-gold/50 focus:outline-none text-base text-gray-100 placeholder:text-gray-600"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      {hasResults && (
        <div className="px-3 pt-2 shrink-0">
          <SearchControls
            scope={filters.scope}
            setScope={filters.setScope}
            hiddenVariants={filters.hiddenVariants}
            hiddenSets={filters.hiddenSets}
            toggleVariant={filters.toggleVariant}
            toggleSet={filters.toggleSet}
            clearAll={filters.clearAll}
            totalHidden={filters.totalHidden}
            relevantSets={relevantSets}
            filterOpen={filterOpen}
            setFilterOpen={setFilterOpen}
            priceMode={priceMode}
            onPriceModeChange={onPriceModeChange}
            mainCount={countSets(results, 'main')}
            promoCount={countSets(results, 'promo')}
          />
        </div>
      )}

      {!hasResults ? (
        <div className="flex-1 flex items-start justify-center pt-10 text-center text-xs text-gray-500">
          Type a card name to search
        </div>
      ) : (
        <CardResultsGrid
          results={results}
          query={query}
          isSearching={isSearching}
          scope={filters.scope}
          hiddenVariants={filters.hiddenVariants}
          hiddenSets={filters.hiddenSets}
          // Tighter grids for the narrower drawer — one col less at each
          // breakpoint than the trade overlay.
          portraitColsClass="grid-cols-4 sm:grid-cols-4 md:grid-cols-5"
          landscapeColsClass="grid-cols-3 sm:grid-cols-3 md:grid-cols-4"
          renderTile={(card, ctx) => (
            <PickerTile
              key={`${card.name}-${card.set}-${card.productId ?? ''}`}
              card={card}
              percentage={percentage}
              priceMode={priceMode}
              landscape={ctx.leaderGroup}
              onPick={() => onPick(card)}
            />
          )}
        />
      )}
    </div>
  );
}

interface PickerTileProps {
  card: CardVariant;
  percentage: number;
  priceMode: PriceMode;
  landscape: boolean;
  onPick: () => void;
}

function PickerTile({ card, percentage, priceMode, landscape, onPick }: PickerTileProps) {
  const variant = extractVariantLabel(card.name);
  const variantLabel = variantDisplayLabel(variant);
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');

  return (
    <button
      type="button"
      onClick={onPick}
      className="group flex flex-col items-stretch rounded-lg bg-space-800/80 border border-space-700 hover:border-gold/40 active:scale-[0.98] transition-all text-left overflow-hidden"
    >
      <div
        className={`${landscape ? 'aspect-[7/5]' : 'aspect-[5/7]'} bg-space-900 overflow-hidden`}
      >
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={card.name}
            loading="lazy"
            className="w-full h-full object-contain"
          />
        ) : null}
      </div>
      <div className="px-1.5 py-1 flex items-center gap-1">
        {variantLabel && (
          <span className={`text-[8px] leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide ${variantBadgeColor(variant)}`}>
            {variantLabel}
          </span>
        )}
        {price !== null && (
          <span className="ml-auto text-[10px] text-gold font-semibold">
            ${price.toFixed(2)}
          </span>
        )}
      </div>
    </button>
  );
}

function BackIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 12L6 8L10 4" />
    </svg>
  );
}
