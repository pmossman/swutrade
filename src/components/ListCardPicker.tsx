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
import { extractVariantLabel, variantBadgeColor, variantDisplayLabel, cardFamilyId } from '../variants';
import { CardResultsGrid } from './CardResultsGrid';
import { SearchControls } from './SearchControls';

const promoSlugs = new Set(SETS.filter(s => s.category === 'promo').map(s => s.slug));

export type PickerListType = 'wants' | 'available';
export type PickerWantsMode = 'any' | 'specific';

export interface PickContext {
  /** For wants picker: whether the user is in 'any' or 'specific' mode. */
  wantsMode?: PickerWantsMode;
}

interface ListCardPickerProps {
  listType: PickerListType;
  allCards: CardVariant[];
  filters: ReturnType<typeof useSearchFilters>;
  percentage: number;
  priceMode: PriceMode;
  onPriceModeChange: (mode: PriceMode) => void;
  title: string;
  /** Count already in list, keyed by identifier:
   *   - wants: familyId → total qty across every wants item in that family
   *   - available: productId → qty for that exact variant */
  savedCounts: Map<string, number>;
  onPick: (card: CardVariant, ctx: PickContext) => void;
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
 * Pick the variant best suited to represent a base card in "Any" mode.
 * Prefer Standard (cheapest common printing) so the tile reads as the
 * canonical card, not a Showcase. Falls back to the first variant when
 * Standard isn't present (e.g. promo-only cards).
 */
function representativeVariant(variants: CardVariant[]): CardVariant {
  return variants.find(v => extractVariantLabel(v.name) === 'Standard') ?? variants[0];
}

/**
 * Embedded card-search surface for the Lists drawer. Reuses the same
 * SearchControls + CardResultsGrid as the main trade search so filter
 * preferences and set-grouped results stay consistent across the app.
 *
 * Wants picker adds an Any / Specific toggle:
 *   - Any: one tile per base card; tapping saves with restriction = any.
 *   - Specific: one tile per variant; tapping saves with restriction =
 *     restricted to that variant.
 *
 * Picker does NOT auto-close on pick. Users stay in the search to add
 * more cards or adjust qty (re-tap bumps qty on the existing entry).
 * Tiles show a saved-count badge so users see at a glance what they've
 * already added.
 */
export function ListCardPicker({
  listType,
  allCards,
  filters,
  percentage,
  priceMode,
  onPriceModeChange,
  title,
  savedCounts,
  onPick,
  onClose,
}: ListCardPickerProps) {
  const { query, setQuery, results, isSearching } = useCardSearch({
    allCards,
    setFilter: null,
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const [wantsMode, setWantsMode] = useState<PickerWantsMode>('any');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const hasResults = query.length >= 2;

  const relevantSets = useMemo(
    () => relevantSetsForControls(results, filters.scope),
    [results, filters.scope],
  );

  // In wants/Any mode, collapse each base-card group to its
  // representative variant so the picker shows one tile per card.
  const viewResults = useMemo<SetSearchGroup[]>(() => {
    if (listType !== 'wants' || wantsMode !== 'any') return results;
    return results.map(sg => ({
      ...sg,
      groups: sg.groups.map(g => ({
        ...g,
        variants: g.variants.length > 0 ? [representativeVariant(g.variants)] : [],
      })),
    }));
  }, [results, listType, wantsMode]);

  const pickContext: PickContext = listType === 'wants' ? { wantsMode } : {};

  // Key a tile against the saved-count map: wants counts keyed by
  // cardFamilyId (cross-printing), available counts by productId.
  const tileKey = (card: CardVariant): string | null => {
    if (listType === 'wants') return cardFamilyId(card);
    return card.productId ?? null;
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-space-800 shrink-0">
        <button
          type="button"
          onClick={onClose}
          aria-label="Done"
          className="shrink-0 text-gray-500 hover:text-gray-200 transition-colors p-1 -ml-1"
        >
          <BackIcon className="w-4 h-4" />
        </button>
        <span className="text-[11px] font-bold tracking-[0.1em] uppercase text-gray-400">
          {title}
        </span>
        {listType === 'wants' && (
          <div className="ml-auto flex items-center gap-0.5 rounded-md bg-space-800 border border-space-700 p-0.5">
            <WantsModeButton
              active={wantsMode === 'any'}
              onClick={() => setWantsMode('any')}
              title="One tile per card; any variant accepted"
            >
              Any
            </WantsModeButton>
            <WantsModeButton
              active={wantsMode === 'specific'}
              onClick={() => setWantsMode('specific')}
              title="One tile per variant; save a specific printing"
            >
              Specific
            </WantsModeButton>
          </div>
        )}
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
          results={viewResults}
          query={query}
          isSearching={isSearching}
          scope={filters.scope}
          hiddenVariants={filters.hiddenVariants}
          hiddenSets={filters.hiddenSets}
          portraitColsClass="grid-cols-4 sm:grid-cols-4 md:grid-cols-5"
          landscapeColsClass="grid-cols-3 sm:grid-cols-3 md:grid-cols-4"
          renderTile={(card, ctx) => {
            const key = tileKey(card);
            const savedQty = key ? savedCounts.get(key) ?? 0 : 0;
            return (
              <PickerTile
                key={`${card.name}-${card.set}-${card.productId ?? ''}`}
                card={card}
                percentage={percentage}
                priceMode={priceMode}
                landscape={ctx.leaderGroup}
                savedQty={savedQty}
                showVariantBadge={listType === 'available' || wantsMode === 'specific'}
                onPick={() => onPick(card, pickContext)}
              />
            );
          }}
        />
      )}
    </div>
  );
}

function WantsModeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide transition-colors ${
        active ? 'bg-gold/20 text-gold' : 'text-gray-500 hover:text-gray-300'
      }`}
    >
      {children}
    </button>
  );
}

interface PickerTileProps {
  card: CardVariant;
  percentage: number;
  priceMode: PriceMode;
  landscape: boolean;
  /** Current total qty of this card saved to the list (0 if not saved). */
  savedQty: number;
  /** Show the variant badge — true for available and wants/specific,
   *  false for wants/any where the tile represents a base card. */
  showVariantBadge: boolean;
  onPick: () => void;
}

function PickerTile({
  card,
  percentage,
  priceMode,
  landscape,
  savedQty,
  showVariantBadge,
  onPick,
}: PickerTileProps) {
  const variant = extractVariantLabel(card.name);
  const variantLabel = variantDisplayLabel(variant);
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');

  return (
    <button
      type="button"
      onClick={onPick}
      className={`group relative flex flex-col items-stretch rounded-lg bg-space-800/80 border transition-all text-left overflow-hidden active:scale-[0.98] ${
        savedQty > 0
          ? 'border-gold/40 hover:border-gold/60'
          : 'border-space-700 hover:border-gold/40'
      }`}
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
      {savedQty > 0 && (
        <span
          className="absolute top-1 right-1 px-1.5 py-0.5 rounded-full bg-gold text-space-900 text-[10px] font-bold leading-none shadow"
          aria-label={`${savedQty} saved`}
        >
          ×{savedQty}
        </span>
      )}
      <div className="px-1.5 py-1 flex items-center gap-1">
        {showVariantBadge && variantLabel && (
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
