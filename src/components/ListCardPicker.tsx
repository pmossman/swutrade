import { useMemo, useRef, useEffect, useDeferredValue } from 'react';
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
  variantShortLabel,
  cardFamilyId,
  type CanonicalVariant,
} from '../variants';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
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
  /** Full wants API (when listType === 'wants'). Picker reads items
   *  for the saved-qty badge and uses update/remove to support
   *  tap-to-decrement on already-saved tiles. */
  wants?: WantsApi;
  /** Full available API (when listType === 'available'). */
  available?: AvailableApi;
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

interface TileBadge {
  text: string;
  colorClass: string;
}

/**
 * Badge pills for a picker tile. Communicates what a tap would save:
 *   - Available: single pill with the tile's exact variant.
 *   - Wants, no filter (Any): gold "Any" pill so the user sees that
 *     tapping saves a cross-variant want, not just the visible rep.
 *   - Wants, 1 filter variant: single pill with that variant.
 *   - Wants, 2+ filter variants: one pill per variant in its own
 *     variant color — makes the saved restriction scannable at a
 *     glance. Rendered in the same order the user selected.
 */
const ANY_BADGE_COLOR = 'bg-gold/15 text-gold border border-gold/40';

function wantsBadge(
  card: CardVariant,
  listType: PickerListType,
  selectedVariants: readonly CanonicalVariant[],
): TileBadge[] | null {
  const variant = extractVariantLabel(card.name);
  if (listType === 'available') {
    const label = variant === 'Standard' ? 'Standard' : variantDisplayLabel(variant);
    return label ? [{ text: label, colorClass: variantBadgeColor(variant) }] : null;
  }
  if (selectedVariants.length === 0) {
    return [{ text: 'Any', colorClass: ANY_BADGE_COLOR }];
  }
  if (selectedVariants.length === 1) {
    const v = selectedVariants[0];
    const label = variantDisplayLabel(v) || v;
    return [{ text: label, colorClass: variantBadgeColor(v) }];
  }
  return selectedVariants.map(v => ({
    text: variantShortLabel(v),
    colorClass: variantBadgeColor(v),
  }));
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
  wants,
  available,
  onPick,
  onClose,
}: ListCardPickerProps) {
  const wantsItems = wants?.items ?? [];
  const availableItems = available?.items ?? [];
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

  const hasQuery = query.length >= 2;

  const { selectedVariants, selectedSets } = filters;

  // Browse mode: when the user hasn't typed, render the whole catalog
  // (respecting filters) so they can pick cards without having to
  // search by name.
  const browseResults = useMemo(() => browseAllGroups(allCards), [allCards]);
  const baseResults = hasQuery ? results : browseResults;

  // Wants picker: collapse each family to a single tile using the rep
  // that matches the current variant filter (cheapest match, or
  // Standard when filter is empty) — a saved Want is a cross-printing
  // entity, so showing every variant would be confusing.
  // Available picker: show every variant as its own tile since
  // productIds are exact. The variant filter doesn't apply here
  // (the UI hides it); any persisted selection is ignored.
  const viewResults = useMemo<SetSearchGroup[]>(() => {
    const setScoped = applySelectionFilters(
      baseResults,
      selectedSets,
      [],
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
  }, [baseResults, listType, selectedSets, selectedVariants, priceMode]);

  // Saved-count lookup + item-id reverse index. For wants, scope by
  // (familyId + filter restriction key) so a Hyperspace-saved Luke
  // doesn't show a count when the filter is "Any" (different
  // restriction → different item). The id list lets decrement find
  // the right row to touch.
  const { savedCounts, savedItemIds } = useMemo(() => {
    const counts = new Map<string, number>();
    const ids = new Map<string, string[]>();
    const push = (key: string, id: string, qty: number) => {
      counts.set(key, (counts.get(key) ?? 0) + qty);
      const bucket = ids.get(key);
      if (bucket) bucket.push(id);
      else ids.set(key, [id]);
    };
    if (listType === 'wants') {
      const filterKey = restrictionKeyOf(selectedVariants);
      for (const item of wantsItems) {
        const itemKey = item.restriction.mode === 'any'
          ? 'any'
          : restrictionKeyOf(item.restriction.variants);
        if (itemKey !== filterKey) continue;
        push(item.familyId, item.id, item.qty);
      }
    } else {
      for (const item of availableItems) {
        push(item.productId, item.id, item.qty);
      }
    }
    return { savedCounts: counts, savedItemIds: ids };
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

  // Decrement: tapping the ×N badge removes one qty. Finds the newest
  // matching item (by pop from the id list) and decrements, or removes
  // it entirely at qty 1.
  const handleDecrement = (card: CardVariant) => {
    const key = tileKey(card);
    if (!key) return;
    const ids = savedItemIds.get(key);
    if (!ids || ids.length === 0) return;
    const itemId = ids[ids.length - 1];
    if (listType === 'wants' && wants) {
      const item = wants.items.find(i => i.id === itemId);
      if (!item) return;
      if (item.qty <= 1) wants.remove(itemId);
      else wants.update(itemId, { qty: item.qty - 1 });
    } else if (listType === 'available' && available) {
      const item = available.items.find(i => i.id === itemId);
      if (!item) return;
      if (item.qty <= 1) available.remove(itemId);
      else available.update(itemId, { qty: item.qty - 1 });
    }
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
        {/* Available cards are always exact variants (keyed by
            productId), so narrowing the view by variant would just
            hide rows without changing what gets saved. Hide the
            variant chip group entirely in that picker. */}
        <SelectionFilterBar filters={filters} hideVariantFilter={listType === 'available'} />
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
          // Badge wording reflects what a tap will actually save:
          //   - Available: exact tile variant (productId is precise).
          //   - Wants with 0-variant filter: tile variant only when
          //     non-Standard (family has no Standard printing).
          //   - Wants with 1-variant filter: the chosen variant.
          //   - Wants with 2+ variants: "HS or HSF" so the user can
          //     see the whole restriction they'll save on tap.
          const badge = wantsBadge(card, listType, selectedVariants);
          return (
            <PickerTile
              key={`${card.name}-${card.set}-${card.productId ?? ''}`}
              card={card}
              percentage={percentage}
              priceMode={priceMode}
              landscape={ctx.leaderGroup}
              savedQty={savedQty}
              badge={badge}
              onPick={() => onPick(card, pickContext)}
              onDecrement={savedQty > 0 ? () => handleDecrement(card) : undefined}
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
  /** Caption pills above the price. Parent computes label + color so
   *  each pill can reflect either the tile's variant (Available) or
   *  one element of the active restriction (Wants with multi-variant
   *  filter). */
  badge: TileBadge[] | null;
  onPick: () => void;
  /** Decrement one saved qty. Only passed when savedQty > 0. */
  onDecrement?: () => void;
}

function PickerTile({
  card,
  percentage,
  priceMode,
  landscape,
  savedQty,
  badge,
  onPick,
  onDecrement,
}: PickerTileProps) {
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');

  return (
    <div className="relative">
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
        {/* Caption: badge(s) + price stacked so neither gets clipped at
            narrow mobile tile widths. Multi-badge rows wrap to a new
            line if needed. */}
        <div className="px-1.5 py-1 flex flex-col items-start gap-0.5">
          {badge && badge.length > 0 && (
            <div className="flex flex-wrap gap-0.5">
              {badge.map((b, i) => (
                <span
                  key={`${b.text}-${i}`}
                  className={`text-[8px] leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide ${b.colorClass}`}
                >
                  {b.text}
                </span>
              ))}
            </div>
          )}
          {price !== null && (
            <span className="text-[10px] text-gold font-semibold">
              ${price.toFixed(2)}
            </span>
          )}
        </div>
      </button>
      {/* Decrement button — sibling of the main tile button so its
          tap doesn't double as an add. Only shows for saved tiles. */}
      {onDecrement && (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onDecrement(); }}
          aria-label={savedQty <= 1 ? 'Remove' : 'Decrease quantity'}
          className="absolute top-1 left-1 z-[2] w-6 h-6 rounded-full bg-space-900/85 border border-space-700 text-gray-200 hover:text-crimson-light hover:border-crimson/60 flex items-center justify-center text-sm font-bold leading-none transition-colors"
        >
          {savedQty <= 1 ? '×' : '−'}
        </button>
      )}
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
