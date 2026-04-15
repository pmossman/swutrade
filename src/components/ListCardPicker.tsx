import { useMemo, useRef, useEffect } from 'react';
import type { CardVariant, PriceMode } from '../types';
import { useCardSearch, type SetSearchGroup } from '../hooks/useCardSearch';
import { useSelectionFilters } from '../hooks/useSelectionFilters';
import { PERSIST_KEYS } from '../persistence';
import {
  cardImageUrl,
  adjustPrice,
  getCardPrice,
} from '../services/priceService';
import {
  extractVariantLabel,
  variantBadgeColor,
  variantDisplayLabel,
  cardFamilyId,
  type CanonicalVariant,
} from '../variants';
import type { WantsItem, AvailableItem } from '../persistence';
import { CardResultsGrid } from './CardResultsGrid';
import { SelectionFilterBar } from './SelectionFilterBar';
import { applySelectionFilters } from '../applySelectionFilters';

export type PickerListType = 'wants' | 'available';

export interface PickContext {
  /** For wants picker: the variant filter active when the user tapped.
   *  Empty array means "any variant" — the tap should save with
   *  restriction.mode = 'any'. Non-empty means restriction.mode =
   *  'restricted' with these variants. */
  acceptedVariants?: CanonicalVariant[];
}

interface ListCardPickerProps {
  listType: PickerListType;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
  title: string;
  /** Wants items (when listType === 'wants') — used to compute the
   *  saved-qty badge on each tile, scoped to the current variant
   *  filter so the badge reflects what *another tap would dedupe with*. */
  wantsItems?: readonly WantsItem[];
  /** Available items (when listType === 'available') — used for
   *  productId-keyed saved-qty badge. */
  availableItems?: readonly AvailableItem[];
  onPick: (card: CardVariant, ctx: PickContext) => void;
  onClose: () => void;
}

function representativeVariant(variants: CardVariant[]): CardVariant {
  return variants.find(v => extractVariantLabel(v.name) === 'Standard') ?? variants[0];
}

function cheapestVariant(variants: CardVariant[], priceMode: PriceMode): CardVariant {
  return variants.reduce((best, c) => {
    const bp = getCardPrice(best, priceMode) ?? Infinity;
    const cp = getCardPrice(c, priceMode) ?? Infinity;
    return cp < bp ? c : best;
  });
}

function restrictionKeyOf(variants: readonly string[]): string {
  if (variants.length === 0) return 'any';
  return [...variants].sort().join('|');
}

/**
 * Embedded card-search surface for the Lists drawer.
 *
 * Carries its own persisted variant + set filters (distinct from the
 * trade view's filters), driving two behaviors for wants:
 *   1. Tile rep: filter picks the cheapest matching variant per family,
 *      dropping families that have no matching variant.
 *   2. Saved restriction on tap: the active variant filter becomes the
 *      wants item's restriction.
 *
 * Picker stays open across taps so a user can set filters once and
 * type-tap-type-tap through a batch of cards.
 */
export function ListCardPicker({
  listType,
  allCards,
  percentage,
  priceMode,
  title,
  wantsItems = [],
  availableItems = [],
  onPick,
  onClose,
}: ListCardPickerProps) {
  const { query, setQuery, results, isSearching } = useCardSearch({
    allCards,
    setFilter: null,
  });
  const filters = useSelectionFilters({
    variants: PERSIST_KEYS.pickerSelVariants,
    sets: PERSIST_KEYS.pickerSelSets,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const hasResults = query.length >= 2;

  const { selectedVariants, selectedSets } = filters;

  // For the wants picker, collapse each family to a single tile using
  // the rep that matches the current variant filter (cheapest match, or
  // Standard when filter is empty). Available picker shows every variant
  // as its own tile since productIds are exact.
  const viewResults = useMemo<SetSearchGroup[]>(() => {
    // Apply set filter to all surfaces; variant filter is applied
    // differently for wants (rep collapse) vs available (straight filter).
    const setScoped = applySelectionFilters(
      results,
      selectedSets,
      listType === 'available' ? selectedVariants : [],
    );

    if (listType !== 'wants') return setScoped;

    return setScoped.map(sg => ({
      ...sg,
      groups: sg.groups
        .map(g => {
          if (selectedVariants.length === 0) {
            return g.variants.length > 0
              ? { ...g, variants: [representativeVariant(g.variants)] }
              : null;
          }
          const matching = g.variants.filter(c =>
            (selectedVariants as readonly string[]).includes(extractVariantLabel(c.name)),
          );
          if (matching.length === 0) return null;
          return { ...g, variants: [cheapestVariant(matching, priceMode)] };
        })
        .filter((g): g is NonNullable<typeof g> => g !== null),
    }));
  }, [results, listType, selectedSets, selectedVariants, priceMode]);

  // Saved-count lookup. For wants, scope by (familyId + filter
  // restriction key) so a Hyperspace-saved Luke doesn't show a count
  // when the filter is "Any" (different restriction → different item).
  const savedCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (listType === 'wants') {
      const filterKey = restrictionKeyOf(selectedVariants);
      for (const item of wantsItems) {
        const itemKey = item.restriction.mode === 'any'
          ? 'any'
          : restrictionKeyOf(item.restriction.variants);
        if (itemKey !== filterKey) continue;
        m.set(item.familyId, (m.get(item.familyId) ?? 0) + item.qty);
      }
    } else {
      for (const item of availableItems) {
        m.set(item.productId, (m.get(item.productId) ?? 0) + item.qty);
      }
    }
    return m;
  }, [listType, wantsItems, availableItems, selectedVariants]);

  const tileKey = (card: CardVariant): string | null => {
    if (listType === 'wants') return cardFamilyId(card);
    return card.productId ?? null;
  };

  const pickContext: PickContext = listType === 'wants'
    ? { acceptedVariants: selectedVariants }
    : {};

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
      </div>

      <div className="px-3 pt-2 shrink-0">
        <SelectionFilterBar filters={filters} />
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

      {!hasResults ? (
        <div className="flex-1 flex items-start justify-center pt-10 text-center text-xs text-gray-500">
          Type a card name to search
        </div>
      ) : (
        <CardResultsGrid
          results={viewResults}
          query={query}
          isSearching={isSearching}
          portraitColsClass="grid-cols-4 sm:grid-cols-4 md:grid-cols-5"
          landscapeColsClass="grid-cols-3 sm:grid-cols-3 md:grid-cols-4"
          renderTile={(card, ctx) => {
            const key = tileKey(card);
            const savedQty = key ? savedCounts.get(key) ?? 0 : 0;
            // Show variant badge when the rep represents a specific
            // variant: always for available, and for wants whenever the
            // filter is active OR the rep itself is non-Standard (e.g.
            // "Any" filter but the family has no Standard printing).
            const variant = extractVariantLabel(card.name);
            const showBadge = listType === 'available'
              || (listType === 'wants' && (selectedVariants.length > 0 || variant !== 'Standard'));
            return (
              <PickerTile
                key={`${card.name}-${card.set}-${card.productId ?? ''}`}
                card={card}
                percentage={percentage}
                priceMode={priceMode}
                landscape={ctx.leaderGroup}
                savedQty={savedQty}
                showVariantBadge={showBadge}
                onPick={() => onPick(card, pickContext)}
              />
            );
          }}
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
  savedQty: number;
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
