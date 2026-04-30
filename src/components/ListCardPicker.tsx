import { useMemo, useRef, useState, useEffect, useDeferredValue } from 'react';
import type { CardVariant, PriceMode } from '../types';
import { useCardSearch, browseAllGroups, type SetSearchGroup } from '../hooks/useCardSearch';
import { useSelectionFilters } from '../hooks/useSelectionFilters';
import { PERSIST_KEYS } from '../persistence';
import { getCardPrice } from '../services/priceService';
import {
  extractVariantLabel,
  variantBadgeColor,
  variantDisplayLabel,
  variantShortLabel,
  cardFamilyId,
  type CanonicalVariant,
} from '../variants';
import { CardResultsGrid } from './CardResultsGrid';
import { CardTile } from './CardTile';
import { FamilyRow } from './FamilyRow';
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
 *     Variant filter chips visible — they drive the saved
 *     restriction. Empty filter → save as "any printing"; one or
 *     more variants selected → save as that variant restriction.
 *     Used for wishlist + looking-for signals.
 *
 * Earlier iterations had an `either` mode with a "Save As: any /
 * specific" toggle alongside the variant filter; that was removed
 * because the variant filter chips already do the same job — having
 * both controls confused users. `family` mode + the variant filter
 * is the single primitive now.
 */
export type SelectionMode =
  | { kind: 'specific' }
  | { kind: 'family' };

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
      selectionMode: { kind: 'family' };
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
  /** One-shot initial value for the search input. Used by the trade
   *  overlay's seed flow (e.g. opening the overlay pre-filled with
   *  a card name from the swap-variant kebab). */
  initialQuery?: string;
  /** Verb-target string for tile aria-labels — "Add Luke (HS) to ${target}".
   *  Defaults to "list"; the trade overlay overrides to "trade" so
   *  screen readers + e2e tests can disambiguate the surface. */
  actionTarget?: string;
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
  initialQuery,
  actionTarget = 'list',
}: ListCardPickerProps) {
  // Active tile mode is just the selectionMode kind — no in-picker
  // toggle anymore. The variant filter chips drive the saved
  // restriction in 'family' mode.
  const activeMode = selectionMode.kind;

  // Family-mode strip data: map familyId → all printings (sorted
  // cheapest-first). Built once per allCards reference; the family
  // tile reads from this to render its variant strip.
  const familyVariantsMap = useMemo(() => {
    if (activeMode !== 'family') return null;
    const map = new Map<string, CardVariant[]>();
    for (const c of allCards) {
      const fid = cardFamilyId(c);
      const list = map.get(fid) ?? [];
      list.push(c);
      map.set(fid, list);
    }
    // Sort each family by market price ascending so the strip
    // surfaces the cheapest variant left-to-right (consistent with
    // the picker's family-rep selection).
    for (const list of map.values()) {
      list.sort((a, b) => (getCardPrice(a, priceMode) ?? Infinity) - (getCardPrice(b, priceMode) ?? Infinity));
    }
    return map;
  }, [activeMode, allCards, priceMode]);
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

  // Seed initialQuery once on mount so callers (e.g. the trade overlay's
  // swap-variant kebab) can pre-fill the search. The ref guard prevents
  // a parent re-render with the same prop from clobbering user typing.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (initialQuery) setQuery(initialQuery);
  }, [initialQuery, setQuery]);

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
  const browseSource = browsePool ?? allCards;
  // For a scoped browsePool (chip-active overlay use) the source is
  // small (often <50 cards), so compute synchronously — the user
  // just clicked a chip and expects an immediate re-render.
  // For the full catalog (~8000 cards) we defer past first paint via
  // requestIdleCallback so the picker chrome appears instantly when
  // the user clicks "Add a card" rather than blocking on the heavy
  // iteration first.
  const isScopedPool = browsePool !== undefined;
  const [browseResults, setBrowseResults] = useState<SetSearchGroup[]>(
    () => isScopedPool ? browseAllGroups(browseSource) : [],
  );
  useEffect(() => {
    if (isScopedPool) {
      setBrowseResults(browseAllGroups(browseSource));
      return;
    }
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      setBrowseResults(browseAllGroups(browseSource));
    };
    const ric = (typeof window !== 'undefined' && 'requestIdleCallback' in window)
      ? (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback
      : null;
    if (ric) ric(run);
    else setTimeout(run, 0);
    return () => { cancelled = true; };
  }, [browseSource, isScopedPool]);

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
    // Self-constrain to a readable column width so card thumbs stay
    // a sensible size on wide screens. Without this, the trade
    // overlay (which doesn't wrap the picker) renders cards 2x
    // larger than the wishlist picker (which the parent constrains)
    // — felt jarring across surfaces.
    <div className="flex flex-col flex-1 min-h-0 max-w-3xl mx-auto w-full">
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

      {/* Filter region: variant + set chips on top, source-pool chips
          inline beneath when the consumer supplies any. Wrapping both
          in one bordered panel reads as a single "what's narrowing my
          view" region — keeps the source chips from feeling orphaned
          above the variant pills.
          Variant filter chips only make sense in family tile mode —
          they drive which restriction a click saves. In specific
          tile mode each tile IS its own variant; chips would just
          duplicate that signal. */}
      <div className="px-3 pt-2 shrink-0">
        <SelectionFilterBar
          filters={filters}
          hideVariantFilter={activeMode === 'specific'}
          extraChips={chips}
        />
      </div>

      <div className="px-3 py-2 shrink-0">
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
        // Family mode is one full-width row per family — collapse the
        // grid to a single column so FamilyRow gets the row width.
        // Specific mode keeps the multi-column tile grid.
        portraitColsClass={activeMode === 'family' ? 'grid-cols-1' : 'grid-cols-4 sm:grid-cols-4 md:grid-cols-5'}
        landscapeColsClass={activeMode === 'family' ? 'grid-cols-1' : 'grid-cols-3 sm:grid-cols-3 md:grid-cols-4'}
        // Tuned to FamilyRow's actual rendered height (~120px for the
        // 96px-tall variant stacks + padding + group label) so the
        // virtualizer's scrollbar doesn't overestimate by 2x. The
        // virtualizer measures real height post-render anyway, but
        // the initial estimate sets the scroll-extent feel.
        rowHeightEstimate={activeMode === 'family' ? () => 130 : undefined}
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
          // Badge prop reflects what a tap will actually save:
          //   - Specific mode: tile's intrinsic variant (CardTile's
          //     default behavior; pass `undefined` so it computes
          //     itself).
          //   - Family mode with 0-variant filter: gold "Any" pill.
          //   - Family mode with 1-variant filter: the chosen variant.
          //   - Family mode with 2+ variants: one pill each.
          // The compute-it-here path matches family-mode semantics;
          // specific mode lets CardTile render its own variant pill.
          const tileBadge = activeMode === 'specific'
            ? undefined
            : wantsBadge(card, activeMode, selectedVariants);
          // pickContext per-tile: in specific mode each tile click
          // pins THAT tile's variant; in family mode the active
          // variant filter pins the restriction.
          const tilePickContext: PickContext = activeMode === 'specific'
            ? { acceptedVariants: [extractVariantLabel(card.name) as CanonicalVariant] }
            : pickContext;
          if (activeMode === 'family' && familyVariantsMap) {
            // Family mode: full-width FamilyRow with stacked active +
            // excluded variants. The picker has already collapsed the
            // group to one rep card; we look up the full variant list
            // from the prebuilt familyVariantsMap.
            const familyId = cardFamilyId(card);
            const allVariants = familyVariantsMap.get(familyId) ?? [card];
            return (
              <FamilyRow
                key={`${card.name}-${card.set}`}
                primary={card}
                allVariants={allVariants}
                activeVariantLabels={selectedVariants}
                qty={savedQty}
                priceMode={priceMode}
                accent={accent}
                actionTarget={actionTarget}
                onAdd={() => onPick(card, tilePickContext)}
                onDecrement={() => handleDecrement(card)}
              />
            );
          }
          return (
            <CardTile
              key={`${card.name}-${card.set}-${card.productId ?? ''}`}
              card={card}
              qty={savedQty}
              // Picker tile prices are always raw TCGPlayer (mkt/low),
              // never the user's trade-balancer percentage. The list
              // picker is a "browse the catalogue" surface; showing
              // 80%-adjusted prices here makes cross-reference with
              // TCGPlayer needlessly hard. The trade view applies the
              // percentage where it actually matters.
              percentage={100}
              priceMode={priceMode}
              accent={accent}
              landscape={ctx.leaderGroup}
              badge={tileBadge}
              actionTarget={actionTarget}
              onAdd={() => onPick(card, tilePickContext)}
              onDecrement={() => handleDecrement(card)}
            />
          );
        }}
      />
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
