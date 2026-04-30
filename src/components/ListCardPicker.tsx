import { useMemo, useRef, useState, useEffect, useDeferredValue } from 'react';
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
import { CardResultsGrid } from './CardResultsGrid';
import { SelectionFilterBar } from './SelectionFilterBar';
import { applySelectionFilters } from '../applySelectionFilters';

export interface PickContext {
  /** Variants the user's click should be saved against. Empty array
   *  means "any printing" (consumer saves with `restriction.mode =
   *  'any'`); a single value means a specific variant pin; multi-
   *  value means a multi-variant restricted set.
   *
   *  Source depends on the picker's active selection mode:
   *    - `specific` mode: always `[card.variant]` (one printing = one
   *      tile, click = pin).
   *    - `family` mode: copies the current variant-filter chip
   *      selection (empty = "Any" filter, save as 'any'). */
  acceptedVariants?: CanonicalVariant[];
}

/**
 * Selection mode controls TWO things: how tiles are laid out (one
 * per family vs one per printing) and what `acceptedVariants` carries
 * back to the consumer.
 *
 *   - `specific` — one tile per printing. Variant filter chips
 *     hidden (each tile is its own variant). Click saves with that
 *     exact variant. Used for binder, offering signals, trade
 *     builder — surfaces where the user is committing to an exact
 *     printing.
 *   - `family` — one tile per family (representative printing).
 *     Variant filter chips visible — the user picks restrictions
 *     up-front, then click saves with that restriction. Used for
 *     wishlist + looking-for signals when a user knows they want
 *     exactly "Luke, any version" or "Luke, only Hyperspace".
 *   - `either` — both modes available with a toggle at the top of
 *     the picker. `default` controls which is active on mount.
 *     Used for wishlist + looking-for signals as the new default
 *     (default: 'family' — most adds are "any", power users
 *     toggle).
 *
 * The `either` flavour assumes `family-keyed` saved-entry shape
 * (PickerWantsSavedEntry) regardless of the active tile layout —
 * because the underlying data model is family-keyed even when the
 * user picks a specific printing (the variant just becomes the
 * restriction).
 */
export type SelectionMode =
  | { kind: 'specific' }
  | { kind: 'family' }
  | { kind: 'either'; default: 'specific' | 'family' };

/**
 * "What's already in the consumer's draft / list" — one entry per
 * row the caller cares about. Two shapes, discriminated by the
 * picker's selection mode:
 *
 *   - `family` / `either` modes: `familyId` + `restrictionKey`
 *     ("any" or pipe-joined variant list). The picker counts a saved
 *     row toward a tile's badge when its restriction matches the
 *     current variant filter (family tile mode) or the tile's own
 *     variant (specific tile mode).
 *   - `specific` mode: `productId`. One tile per printing, keyed
 *     exactly. No restrictionKey field — variants are productId-
 *     disambiguated already.
 *
 * `id` round-trips back via `onDecrement(id)` so the caller can
 * find the right row to mutate.
 */
export interface PickerWantsSavedEntry {
  id: string;
  familyId: string;
  qty: number;
  /** "any" or a pipe-joined sorted variant list (e.g. "Hyperspace"
   *  or "Hyperspace|Showcase"). */
  restrictionKey: string;
}

export interface PickerAvailableSavedEntry {
  id: string;
  productId: string;
  qty: number;
}

type ListCardPickerProps =
  | (CommonPickerProps & {
      selectionMode: { kind: 'specific' };
      savedEntries?: readonly PickerAvailableSavedEntry[];
    })
  | (CommonPickerProps & {
      selectionMode: { kind: 'family' } | { kind: 'either'; default: 'specific' | 'family' };
      savedEntries?: readonly PickerWantsSavedEntry[];
    });

interface CommonPickerProps {
  allCards: CardVariant[];
  /** Optional scoped pool for BROWSE mode only. When set, the
   *  catalog-browse tiles are drawn from this subset (e.g. the
   *  trade-builder source chips like "My available", "They want")
   *  while name search continues to query the full `allCards`. */
  browsePool?: CardVariant[];
  /** Accepted but ignored — picker tile prices are always raw 100%
   *  TCGPlayer (mkt/low). Kept on the interface for symmetry with
   *  the trade builder; both share the same "browse the catalogue
   *  at TCGPlayer prices" contract now. */
  percentage?: number;
  priceMode: PriceMode;
  /** Decrement one qty of the named saved row. Caller decides whether
   *  to drop the row at qty=0 or just decrement; picker only fires
   *  the callback when the user taps the × pill on a badged tile. */
  onDecrement?: (id: string) => void;
  onPick: (card: CardVariant, ctx: PickContext) => void;
  onClose: () => void;
  /** Side accent — drives the Done button colour + saved-tile border.
   *  'gold' for list surfaces (wishlist, binder, signals); 'emerald'
   *  for trade-builder offering side; 'blue' for receiving side. */
  accent?: 'gold' | 'emerald' | 'blue';
  /** Replace the default top bar (Back chevron + Done pill) with
   *  caller-supplied content. Used by the trade overlay to show
   *  counterpart context ("Adding to · for @alice") + a side-tinted
   *  Done. The default bar still wins when this is omitted. */
  header?: React.ReactNode;
  /** Extra row injected between the header and the filter bar.
   *  Trade overlay drops its source chips here. */
  chips?: React.ReactNode;
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
  activeMode: 'specific' | 'family',
  selectedVariants: readonly CanonicalVariant[],
): TileBadge[] | null {
  const variant = extractVariantLabel(card.name);
  if (activeMode === 'specific') {
    // Each tile is its own printing — pill = the tile's variant.
    const label = variant === 'Standard' ? 'Standard' : variantDisplayLabel(variant);
    return label ? [{ text: label, colorClass: variantBadgeColor(variant) }] : null;
  }
  // Family mode: pill = current variant filter (what a click would save).
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
  selectionMode,
  allCards,
  browsePool,
  priceMode,
  savedEntries = [],
  onDecrement,
  onPick,
  onClose,
  accent = 'gold',
  header,
  chips,
}: ListCardPickerProps) {
  // Active tile mode — locked when selectionMode is 'specific' or
  // 'family', toggleable when 'either'. Preserve toggle position
  // across re-renders inside the picker session.
  const [activeMode, setActiveMode] = useState<'specific' | 'family'>(
    () => selectionMode.kind === 'either' ? selectionMode.default : selectionMode.kind,
  );
  // If the parent flips between hard-locked modes (rare — wishlist
  // → binder swap), sync the active mode without forgetting the
  // user's toggle for 'either' surfaces.
  useEffect(() => {
    if (selectionMode.kind === 'specific') setActiveMode('specific');
    else if (selectionMode.kind === 'family') setActiveMode('family');
    // 'either' → leave activeMode at whatever the user picked
  }, [selectionMode.kind]);
  // `percentage` prop is ignored — picker tiles always show raw
  // TCGPlayer prices. Keeping the prop signature stable so callers
  // don't churn.
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
  // search by name. Computing this against ~8000 cards is the most
  // expensive thing the picker does on mount — defer it to a post-
  // paint effect so the picker chrome (search input + filter bar)
  // appears instantly when the user clicks "Add a card", rather than
  // waiting on the heavy compute first.
  const [browseResults, setBrowseResults] = useState<SetSearchGroup[]>([]);
  const browseSource = browsePool ?? allCards;
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      setBrowseResults(browseAllGroups(browseSource));
    };
    // requestIdleCallback when available so the compute happens once
    // the browser has nothing else to do; setTimeout fallback for
    // engines without it (tests, older Safari) so the work still
    // happens but yields back to paint first.
    const ric = (typeof window !== 'undefined' && 'requestIdleCallback' in window)
      ? (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback
      : null;
    if (ric) ric(run);
    else setTimeout(run, 0);
    return () => { cancelled = true; };
  }, [browseSource]);

  // Stale-while-revalidate: keep showing the last settled search
  // results during the 150ms debounce window so the grid doesn't
  // flash between keystrokes. Without this, a user typing "luke"
  // sees the grid swap to "browse all cards" between each keystroke
  // (because `results` clears for sub-2-char queries) — visible
  // flicker. With it, the prior search hits stay until the new
  // search lands.
  const lastSearchResultsRef = useRef<SetSearchGroup[]>([]);
  useEffect(() => {
    if (!isSearching && hasQuery && results.length > 0) {
      lastSearchResultsRef.current = results;
    }
    // Reset the cached results when the user clears the query so
    // the next search starts cold rather than reviving stale hits.
    if (!hasQuery) lastSearchResultsRef.current = [];
  }, [results, isSearching, hasQuery]);
  const baseResults = !hasQuery
    ? browseResults
    : results.length > 0
      ? results
      : lastSearchResultsRef.current.length > 0
        ? lastSearchResultsRef.current
        : browseResults;

  // Family tile mode: collapse each family to a single tile using
  // the rep that matches the current variant filter (cheapest match,
  // or Standard when filter is empty) — a family-level entry is a
  // cross-printing entity, so showing every variant would be
  // confusing.
  // Specific tile mode: show every variant as its own tile.
  const viewResults = useMemo<SetSearchGroup[]>(() => {
    const setScoped = applySelectionFilters(
      baseResults,
      selectedSets,
      [],
    );

    if (activeMode !== 'family') return setScoped;

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
  }, [baseResults, activeMode, selectedSets, selectedVariants, priceMode]);

  // Saved-count lookup + item-id reverse index.
  //
  // Lookup key depends on the active mode + the selectionMode's
  // saved-shape:
  //   - `specific` selectionMode → savedEntries are productId-keyed,
  //     tile keys by productId. Direct match.
  //   - `family` selectionMode → savedEntries are familyId+restriction-
  //     keyed, tile keys by familyId. Filter by current variant filter
  //     (Hyperspace-saved Luke shouldn't badge under "Any" filter).
  //   - `either` selectionMode → savedEntries family-keyed, tile mode
  //     toggleable:
  //       * family tile mode: same as `family` — filter-key match.
  //       * specific tile mode: per-tile, match entries whose
  //         restrictionKey === this tile's variant.
  const { savedCounts, savedItemIds } = useMemo(() => {
    const counts = new Map<string, number>();
    const ids = new Map<string, string[]>();
    const push = (key: string, id: string, qty: number) => {
      counts.set(key, (counts.get(key) ?? 0) + qty);
      const bucket = ids.get(key);
      if (bucket) bucket.push(id);
      else ids.set(key, [id]);
    };
    if (selectionMode.kind === 'specific') {
      const entries = (savedEntries ?? []) as readonly PickerAvailableSavedEntry[];
      for (const entry of entries) {
        push(entry.productId, entry.id, entry.qty);
      }
    } else {
      // family or either: family-keyed entries.
      const entries = (savedEntries ?? []) as readonly PickerWantsSavedEntry[];
      if (activeMode === 'family') {
        const filterKey = restrictionKeyOf(selectedVariants);
        for (const entry of entries) {
          if (entry.restrictionKey !== filterKey) continue;
          push(entry.familyId, entry.id, entry.qty);
        }
      } else {
        // specific tile mode for `either` — bucket per (familyId,
        // variant) so each tile (productId) only badges entries
        // whose pinned variant matches THIS tile.
        for (const entry of entries) {
          push(`${entry.familyId}::${entry.restrictionKey}`, entry.id, entry.qty);
        }
      }
    }
    return { savedCounts: counts, savedItemIds: ids };
  }, [selectionMode.kind, activeMode, savedEntries, selectedVariants]);

  const tileKey = (card: CardVariant): string | null => {
    if (selectionMode.kind === 'specific') return card.productId ?? null;
    if (activeMode === 'family') return cardFamilyId(card);
    // `either` in specific tile mode — match the (familyId, variant)
    // bucket key built above.
    return `${cardFamilyId(card)}::${extractVariantLabel(card.name)}`;
  };

  const pickContext: PickContext = activeMode === 'specific'
    ? { acceptedVariants: [] /* per-tile populated in renderTile via card.variant */ }
    : { acceptedVariants: selectedVariants };

  // Browse mode mounts hundreds of tiles — useDeferredValue lets the
  // picker chrome (filter bar + search input) paint in a high-priority
  // render while the heavy grid fills in as a low-priority follow-up.
  const deferredResults = useDeferredValue(viewResults);

  // Decrement: tapping the ×N badge removes one qty. Finds the newest
  // matching item (by pop from the id list) and asks the caller to
  // decrement it. The caller decides whether to drop the row at qty=0
  // or just decrement — both wishlist (drop-at-0) and signal-builder
  // (drop-at-0) use the same convention today.
  const handleDecrement = (card: CardVariant) => {
    const key = tileKey(card);
    if (!key || !onDecrement) return;
    const ids = savedItemIds.get(key);
    if (!ids || ids.length === 0) return;
    onDecrement(ids[ids.length - 1]);
  };

  // Done button colour matches the side accent — gold for list
  // surfaces, emerald/blue for the trade-builder sides. Caller can
  // override the entire top bar via the `header` slot.
  const doneColors = {
    gold: 'bg-gold/20 border-gold/50 text-gold hover:bg-gold/30 hover:border-gold/70',
    emerald: 'bg-emerald-600 border-emerald-500/70 text-white hover:bg-emerald-500',
    blue: 'bg-blue-600 border-blue-500/70 text-white hover:bg-blue-500',
  }[accent];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {header ?? (
        // Default top bar: back chevron on the left, Done pill on
        // the right. Both fire onClose. Caller can supply a custom
        // header via the slot prop to inject e.g. trade-builder
        // counterpart context.
        <div className="px-3 py-2 border-b border-space-800 shrink-0 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 text-[11px] font-semibold text-gray-500 hover:text-gray-200 transition-colors"
          >
            <BackIcon className="w-3.5 h-3.5" />
            Back
          </button>
          <button
            type="button"
            onClick={onClose}
            className={`px-3 py-1.5 rounded-md border text-xs font-bold tracking-wide transition-colors ${doneColors}`}
          >
            Done
          </button>
        </div>
      )}

      {chips}

      {selectionMode.kind === 'either' && (
        // Toggle visible only on `either` surfaces (wishlist, looking-
        // for signal). Locked modes hide it because the answer is
        // structural — a binder add is always specific, a wants add
        // can be either-or.
        <div className="px-3 pt-2 shrink-0 flex items-center gap-2">
          <span className="text-[10px] font-bold tracking-widest uppercase text-gray-500">Save as</span>
          <div className="inline-flex rounded-md border border-space-700 bg-space-900/40 p-0.5 text-[11px] font-semibold">
            <button
              type="button"
              onClick={() => setActiveMode('family')}
              aria-pressed={activeMode === 'family'}
              className={`px-2 py-1 rounded transition-colors ${
                activeMode === 'family'
                  ? 'bg-gold/20 text-gold'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Any printing
            </button>
            <button
              type="button"
              onClick={() => setActiveMode('specific')}
              aria-pressed={activeMode === 'specific'}
              className={`px-2 py-1 rounded transition-colors ${
                activeMode === 'specific'
                  ? 'bg-gold/20 text-gold'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Specific printing
            </button>
          </div>
        </div>
      )}

      <div className="px-3 pt-2 shrink-0">
        {/* Variant filter chips only make sense in family tile mode —
            they pick which restriction a click saves. In specific
            tile mode each tile IS its own variant; chips would just
            duplicate that signal. Set + aspect chips stay visible
            either way (they narrow which families render). */}
        <SelectionFilterBar filters={filters} hideVariantFilter={activeMode === 'specific'} />
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
          const badge = wantsBadge(card, activeMode, selectedVariants);
          // pickContext per-tile: in specific mode each tile click
          // pins THAT tile's variant; in family mode the active
          // variant filter pins the restriction.
          const tilePickContext: PickContext = activeMode === 'specific'
            ? { acceptedVariants: [extractVariantLabel(card.name) as CanonicalVariant] }
            : pickContext;
          return (
            <PickerTile
              key={`${card.name}-${card.set}-${card.productId ?? ''}`}
              card={card}
              // Picker tile prices are always raw TCGPlayer (mkt/low),
              // never the user's trade-balancer percentage. The wishlist
              // / binder picker is a "browse the catalogue" surface;
              // showing 80%-adjusted prices here makes cross-reference
              // with TCGPlayer needlessly hard. The trade view applies
              // the percentage where it actually matters.
              percentage={100}
              priceMode={priceMode}
              landscape={ctx.leaderGroup}
              savedQty={savedQty}
              badge={badge}
              accent={accent}
              onPick={() => onPick(card, tilePickContext)}
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
  /** Side accent — drives the saved-state border + qty badge. */
  accent: 'gold' | 'emerald' | 'blue';
  onPick: () => void;
  /** Decrement one saved qty. Only passed when savedQty > 0. */
  onDecrement?: () => void;
}

const tileAccent: Record<'gold' | 'emerald' | 'blue', {
  savedBorder: string;
  hoverBorder: string;
  qtyBadge: string;
}> = {
  gold: {
    savedBorder: 'border-gold/40 hover:border-gold/60',
    hoverBorder: 'hover:border-gold/40',
    qtyBadge: 'bg-gold text-space-900',
  },
  emerald: {
    savedBorder: 'border-emerald-500/60 hover:border-emerald-400',
    hoverBorder: 'hover:border-emerald-500/40',
    qtyBadge: 'bg-emerald-500 text-space-900',
  },
  blue: {
    savedBorder: 'border-blue-500/60 hover:border-blue-400',
    hoverBorder: 'hover:border-blue-500/40',
    qtyBadge: 'bg-blue-500 text-space-900',
  },
};

function PickerTile({
  card,
  percentage,
  priceMode,
  landscape,
  savedQty,
  badge,
  accent,
  onPick,
  onDecrement,
}: PickerTileProps) {
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');
  const accentCls = tileAccent[accent];

  // Compose an accessible name from the card art + badge text so
  // screen readers (and e2e tests) can identify each tile. The image
  // is decorative (alt="") since the text covers it.
  const displayName = card.displayName ?? card.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const badgeText = badge?.map(b => b.text).join(' ') ?? '';
  const ariaLabel = `Add ${displayName}${badgeText ? ' ' + badgeText : ''} to list`;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onPick}
        aria-label={ariaLabel}
        className={`group relative flex flex-col items-stretch w-full rounded-lg bg-space-800/95 border transition-all text-left overflow-hidden active:scale-[0.98] ${
          savedQty > 0 ? accentCls.savedBorder : `border-space-700 ${accentCls.hoverBorder}`
        }`}
      >
        <div
          className={`${landscape ? 'aspect-[7/5]' : 'aspect-[5/7]'} bg-space-900 overflow-hidden`}
        >
          {imgUrl ? (
            <img
              src={imgUrl}
              alt=""
              loading="lazy"
              className="w-full h-full object-contain"
            />
          ) : null}
        </div>
        {savedQty > 0 && (
          <span
            className={`absolute top-1 right-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none shadow ${accentCls.qtyBadge}`}
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
