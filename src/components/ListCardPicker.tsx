import { useMemo, useRef, useEffect, useState, useDeferredValue } from 'react';
import type { CardVariant, PriceMode } from '../types';
import { useCardSearch, browseAllGroups, type SetSearchGroup } from '../hooks/useCardSearch';
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
  // Available picker in browse mode: first tap on a family expands
  // it to show all variants; a second tap commits the specific one.
  // Keyed by familyId. Reset whenever the picker exits browse mode.
  const [expandedFamily, setExpandedFamily] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset expand state whenever the user leaves browse mode or shifts
  // the filter window — the expanded family may no longer be relevant.
  useEffect(() => {
    setExpandedFamily(null);
  }, [query, filters.selectedSets, filters.selectedVariants, listType]);

  const hasQuery = query.length >= 2;

  const { selectedVariants, selectedSets } = filters;

  // Browse mode: when the user hasn't typed, render the whole catalog
  // (respecting filters) so they can pick cards without having to
  // search by name.
  const browseResults = useMemo(() => browseAllGroups(allCards), [allCards]);
  const baseResults = hasQuery ? results : browseResults;

  // Per-family variant counts so collapsed Available tiles can show a
  // "card stack" affordance when there's more than one printing behind
  // the rep — signals that tapping expands to reveal the others.
  const familyVariantCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const card of allCards) {
      const fid = cardFamilyId(card);
      m.set(fid, (m.get(fid) ?? 0) + 1);
    }
    return m;
  }, [allCards]);

  // For the wants picker, collapse each family to a single tile using
  // the rep that matches the current variant filter (cheapest match, or
  // Standard when filter is empty). Available picker also collapses
  // while browsing (too many tiles otherwise) — tapping a rep expands
  // that family to show every variant, and a second tap commits the
  // specific one. Typing a query bypasses collapse entirely.
  const viewResults = useMemo<SetSearchGroup[]>(() => {
    const setScoped = applySelectionFilters(
      baseResults,
      selectedSets,
      listType === 'available' ? selectedVariants : [],
    );

    const shouldCollapse = listType === 'wants' || (listType === 'available' && !hasQuery);
    if (!shouldCollapse) return setScoped;

    return setScoped.map(sg => ({
      ...sg,
      groups: sg.groups
        .map(g => {
          // Available picker: if this family is currently expanded,
          // render it in full (every variant) so the user can tap
          // the exact printing they want.
          if (listType === 'available' && g.variants.length > 0) {
            const fid = cardFamilyId(g.variants[0]);
            if (fid === expandedFamily) return g;
          }
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
  }, [baseResults, listType, hasQuery, selectedSets, selectedVariants, priceMode, expandedFamily]);

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

  // Browse mode mounts hundreds of tiles — useDeferredValue lets the
  // picker chrome (filter bar + search input) paint in a high-priority
  // render while the heavy grid fills in as a low-priority follow-up.
  const deferredResults = useDeferredValue(viewResults);

  // Available picker: intercept the first tap to expand a collapsed
  // family rather than saving. Second tap (on an expanded variant)
  // commits normally.
  const handlePick = (card: CardVariant, ctx: PickContext) => {
    if (listType === 'available' && !hasQuery) {
      const fid = cardFamilyId(card);
      if (expandedFamily !== fid) {
        setExpandedFamily(fid);
        return;
      }
    }
    onPick(card, ctx);
    setExpandedFamily(null);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* The active tab above already shows Wants vs Available, so we
          don't need a redundant "Add to X" title here — just a minimal
          back affordance for touch users (desktop can use Esc). */}
      <div className="px-3 py-2 border-b border-space-800 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1 text-[11px] font-semibold text-gray-500 hover:text-gray-200 transition-colors"
        >
          <BackIcon className="w-3.5 h-3.5" />
          Back to list
        </button>
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
          onFocus={e => e.currentTarget.select()}
          placeholder="Search cards..."
          className="w-full px-3 py-2 rounded-lg bg-space-800 border border-space-700 focus:border-gold/50 focus:outline-none text-base text-gray-100 placeholder:text-gray-600"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      <CardResultsGrid
        results={deferredResults}
        isSearching={isSearching}
        portraitColsClass="grid-cols-4 sm:grid-cols-4 md:grid-cols-5"
        landscapeColsClass="grid-cols-3 sm:grid-cols-3 md:grid-cols-4"
        emptyLabel={hasQuery ? 'No cards match your filters' : 'No cards in this filter'}
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
          const fid = cardFamilyId(card);
          // Collapsed Available rep: stack art hints at the variants
          // hiding behind this tile. Only stack when there's actually
          // something to reveal (family has >1 printing).
          const isCollapsedAvailable =
            listType === 'available' && !hasQuery && expandedFamily !== fid;
          const stacked = isCollapsedAvailable && (familyVariantCount.get(fid) ?? 1) > 1;
          // Newly-revealed variants inside the currently-expanded family
          // fade + scale in so the expansion reads as the stack opening.
          const animateIn = listType === 'available' && expandedFamily === fid;
          return (
            <PickerTile
              key={`${card.name}-${card.set}-${card.productId ?? ''}`}
              card={card}
              percentage={percentage}
              priceMode={priceMode}
              landscape={ctx.leaderGroup}
              savedQty={savedQty}
              showVariantBadge={showBadge}
              stacked={stacked}
              animateIn={animateIn}
              onPick={() => handlePick(card, pickContext)}
            />
          );
        }}
      />
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
  /** True when this tile represents a family with hidden variants
   *  behind it — renders a card-stack affordance. */
  stacked?: boolean;
  /** Plays a fade/scale mount animation — used when a family
   *  expands to reveal its variants. */
  animateIn?: boolean;
  onPick: () => void;
}

function PickerTile({
  card,
  percentage,
  priceMode,
  landscape,
  savedQty,
  showVariantBadge,
  stacked,
  animateIn,
  onPick,
}: PickerTileProps) {
  const variant = extractVariantLabel(card.name);
  // Display label is empty for Standard; force "Standard" here so the
  // expanded variant grid (Available picker) has an explicit label on
  // every tile including the base printing.
  const variantLabel = variant === 'Standard' ? 'Standard' : variantDisplayLabel(variant);
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');

  return (
    <div
      className="relative"
      style={animateIn ? { animation: 'pickerTileFanOut 220ms cubic-bezier(0.2, 0.9, 0.3, 1) both' } : undefined}
    >
      {/* Stack illusion: two offset card-backs behind the tile so the
          collapsed Available rep reads as "there are more printings
          here, tap to see them". */}
      {stacked && (
        <>
          <span
            className="absolute inset-0 rounded-lg bg-space-800 border border-space-700 pointer-events-none"
            style={{ transform: 'translate(5px, 5px)', opacity: 0.55 }}
            aria-hidden
          />
          <span
            className="absolute inset-0 rounded-lg bg-space-800 border border-space-700 pointer-events-none"
            style={{ transform: 'translate(2.5px, 2.5px)', opacity: 0.8 }}
            aria-hidden
          />
        </>
      )}
      <button
        type="button"
        onClick={onPick}
        className={`group relative flex flex-col items-stretch w-full rounded-lg bg-space-800/95 border transition-all text-left overflow-hidden active:scale-[0.98] ${
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
        {/* Caption: badge + price stacked so neither gets clipped at narrow
            mobile tile widths (HYPERSPACE + $6.02 doesn't fit on one line
            at the 4-col breakpoint). */}
        <div className="px-1.5 py-1 flex flex-col items-start gap-0.5">
          {showVariantBadge && variantLabel && (
            <span className={`text-[8px] leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide ${variantBadgeColor(variant)}`}>
              {variantLabel}
            </span>
          )}
          {price !== null && (
            <span className="text-[10px] text-gold font-semibold">
              ${price.toFixed(2)}
            </span>
          )}
        </div>
      </button>
    </div>
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
