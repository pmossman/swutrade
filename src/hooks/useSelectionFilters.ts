import { useCallback, useMemo, useState } from 'react';
import {
  StringArraySchema,
  SortBySchema,
  readPersisted,
  writePersisted,
  clearPersisted,
  type SortBy,
} from '../persistence';
import type { CanonicalVariant } from '../variants';

/** Rarity values we expose as filter chips. The catalog also has
 *  "Special" (promo / convention exclusives) but we deliberately leave
 *  it out of the chip row — most users browsing rarities want the
 *  Common/Uncommon/Rare/Legendary axis. Special cards still surface
 *  via the set filter's Special preset. */
export const SELECTABLE_RARITIES = ['Common', 'Uncommon', 'Rare', 'Legendary'] as const;
export type SelectableRarity = typeof SELECTABLE_RARITIES[number];

// --- Pure reducers ---------------------------------------------------------
// Extracted so the mutual-exclusion rules between individual set chips and
// the Main/Special group presets can be tested without a React renderer.

export function toggleVariantReducer<T extends string>(prev: readonly T[], v: T): T[] {
  return (prev as readonly string[]).includes(v)
    ? prev.filter(x => x !== v)
    : [...prev, v];
}

/**
 * Toggle an individual set slug. Tapping a specific set drops any active
 * group preset ('group:main' / 'group:special') so the user can't end up in
 * an ambiguous "Main preset + also this one main set" state — they're
 * either narrowing by preset or by specific sets, not both. Tapping a
 * group slug itself preserves other group slugs (but in practice presets
 * are mutually exclusive, see replaceGroupReducer).
 */
export function toggleSetReducer(prev: readonly string[], slug: string): string[] {
  const base = slug.startsWith('group:')
    ? prev
    : prev.filter(s => !s.startsWith('group:'));
  return base.includes(slug)
    ? base.filter(x => x !== slug)
    : [...base, slug];
}

/**
 * Swap the active group preset. Clears any individual set chips so the
 * user is unambiguously in "broad filter" mode. Pass null to clear
 * everything.
 */
export function replaceGroupReducer(group: string | null): string[] {
  return group ? [group] : [];
}

/**
 * Snapshot of all four filter dimensions in a single memoized
 * object. Consumers that need to recompute when ANY filter changes
 * should depend on this object alone instead of listing each axis
 * individually — that pattern caused a missed-dep bug where adding
 * `selectedRarities` and `sortBy` to the user-facing UI without
 * updating every consumer's useMemo deps left rarity toggles silently
 * not re-filtering the grid.
 *
 * Reference identity is stable as long as none of the four axes
 * change, so `useMemo(..., [filters.snapshot])` gets full
 * invalidation coverage in one slot.
 */
export interface SelectionFiltersSnapshot {
  selectedVariants: readonly CanonicalVariant[];
  selectedSets: readonly string[];
  selectedRarities: readonly SelectableRarity[];
  sortBy: SortBy;
}

export interface SelectionFilters {
  selectedVariants: CanonicalVariant[];
  selectedSets: string[];
  selectedRarities: SelectableRarity[];
  sortBy: SortBy;
  /** Single-object view of the four state values above. Stable
   *  reference until any of them changes; depend on this in
   *  consumer memos to bake-in invalidation correctness. */
  snapshot: SelectionFiltersSnapshot;
  toggleVariant: (v: CanonicalVariant) => void;
  toggleSet: (slug: string) => void;
  /** Swap the active set-group pseudo-slug, ensuring the two known
   *  group slugs ('group:main' and 'group:special') stay mutually
   *  exclusive. Pass null to clear the group while leaving any
   *  individual set chips intact. */
  replaceGroup: (group: string | null) => void;
  toggleRarity: (r: SelectableRarity) => void;
  setSortBy: (s: SortBy) => void;
  clearVariants: () => void;
  clearSets: () => void;
  clearRarities: () => void;
  /** Reset rarity + sort to defaults. Used by the "More filters"
   *  popover's Clear action so the user can wipe just the niche
   *  axes without touching variant/set. */
  clearMoreFilters: () => void;
  clearAll: () => void;
  totalSelected: number;
  /** Count of "more filter" axes that are non-default. Surfaces as
   *  a badge on the popover trigger so users know without opening
   *  whether anything's narrowing their view. */
  moreFiltersActiveCount: number;
  /** Total number of FILTER AXES that are narrowing the result set
   *  right now — variant (1 if any selected), set (1 if any
   *  selected), plus `moreFiltersActiveCount` (rarity + sort). Powers
   *  the "Clear N filters" aggregate affordance that lives at the
   *  right end of the chip row when anything's active. We count axes
   *  rather than individual chips because a user selecting 3 variants
   *  conceptually has *one* filter active (the variant filter), not
   *  three. The mental-model phrase the affordance reads matches:
   *  "Clear 2 filters" → "variant + set", not "Hyperspace + Foil +
   *  SHD". */
  activeAxisCount: number;
}

interface Keys {
  variants: string;
  sets: string;
  rarities: string;
  sortBy: string;
}

function loadArray<T extends string>(key: string): T[] {
  return readPersisted(key, StringArraySchema, []) as T[];
}

function save(key: string, value: string[]) {
  if (value.length === 0) clearPersisted(key);
  else writePersisted(key, value);
}

/**
 * Per-device positive-selection filters for a search surface.
 *
 * Each surface (trade search, lists picker) maintains independent state
 * under its own keys, so a Hyperspace-only picker doesn't narrow what a
 * user sees in trade search. Empty array means "allow all" — narrowing
 * is opt-in.
 */
/** Filter-out unrecognized rarity strings from a persisted array.
 *  Defends against a future Common/Uncommon/Rare/Legendary rename
 *  that'd otherwise leave stale localStorage entries narrowing the
 *  catalog to the empty set. */
function loadRarities(key: string): SelectableRarity[] {
  const raw = readPersisted(key, StringArraySchema, []);
  const allowed = new Set(SELECTABLE_RARITIES as readonly string[]);
  return raw.filter((r): r is SelectableRarity => allowed.has(r));
}

function loadSortBy(key: string): SortBy {
  return readPersisted(key, SortBySchema, 'relevance');
}

function saveSortBy(key: string, value: SortBy) {
  if (value === 'relevance') clearPersisted(key);
  else writePersisted(key, value);
}

export function useSelectionFilters(keys: Keys): SelectionFilters {
  const [selectedVariants, setSelectedVariants] = useState<CanonicalVariant[]>(
    () => loadArray<CanonicalVariant>(keys.variants),
  );
  const [selectedSets, setSelectedSets] = useState<string[]>(
    () => loadArray<string>(keys.sets),
  );
  const [selectedRarities, setSelectedRarities] = useState<SelectableRarity[]>(
    () => loadRarities(keys.rarities),
  );
  const [sortBy, setSortByState] = useState<SortBy>(
    () => loadSortBy(keys.sortBy),
  );

  const toggleVariant = useCallback((v: CanonicalVariant) => {
    setSelectedVariants(prev => {
      const next = toggleVariantReducer(prev, v);
      save(keys.variants, next);
      return next;
    });
  }, [keys.variants]);

  const toggleSet = useCallback((slug: string) => {
    setSelectedSets(prev => {
      const next = toggleSetReducer(prev, slug);
      save(keys.sets, next);
      return next;
    });
  }, [keys.sets]);

  const replaceGroup = useCallback((group: string | null) => {
    const next = replaceGroupReducer(group);
    setSelectedSets(next);
    save(keys.sets, next);
  }, [keys.sets]);

  const toggleRarity = useCallback((r: SelectableRarity) => {
    setSelectedRarities(prev => {
      const next = toggleVariantReducer(prev, r);
      save(keys.rarities, next);
      return next;
    });
  }, [keys.rarities]);

  const setSortBy = useCallback((s: SortBy) => {
    setSortByState(s);
    saveSortBy(keys.sortBy, s);
  }, [keys.sortBy]);

  const clearVariants = useCallback(() => {
    setSelectedVariants([]);
    save(keys.variants, []);
  }, [keys.variants]);

  const clearSets = useCallback(() => {
    setSelectedSets([]);
    save(keys.sets, []);
  }, [keys.sets]);

  const clearRarities = useCallback(() => {
    setSelectedRarities([]);
    save(keys.rarities, []);
  }, [keys.rarities]);

  const clearMoreFilters = useCallback(() => {
    setSelectedRarities([]);
    setSortByState('relevance');
    save(keys.rarities, []);
    saveSortBy(keys.sortBy, 'relevance');
  }, [keys.rarities, keys.sortBy]);

  const clearAll = useCallback(() => {
    setSelectedVariants([]);
    setSelectedSets([]);
    setSelectedRarities([]);
    setSortByState('relevance');
    save(keys.variants, []);
    save(keys.sets, []);
    save(keys.rarities, []);
    saveSortBy(keys.sortBy, 'relevance');
  }, [keys.variants, keys.sets, keys.rarities, keys.sortBy]);

  // "More filters" badge count: rarity narrowing counts as one axis
  // regardless of how many rarities are picked; non-default sort is
  // its own axis. Two axes max, matches the popover's content.
  const moreFiltersActiveCount =
    (selectedRarities.length > 0 ? 1 : 0)
    + (sortBy !== 'relevance' ? 1 : 0);

  // Memoized snapshot of all four filter dimensions. Consumers that
  // recompute when ANY filter changes (e.g. ListCardPicker's
  // viewResults memo) should depend on this single object instead
  // of enumerating each axis — eliminates the missed-dep bug class
  // when new filter dimensions get added (the prior rarity + sort
  // additions silently failed to invalidate consumers' memos).
  const snapshot: SelectionFiltersSnapshot = useMemo(
    () => ({ selectedVariants, selectedSets, selectedRarities, sortBy }),
    [selectedVariants, selectedSets, selectedRarities, sortBy],
  );

  return {
    selectedVariants,
    selectedSets,
    selectedRarities,
    sortBy,
    snapshot,
    toggleVariant,
    toggleSet,
    replaceGroup,
    toggleRarity,
    setSortBy,
    clearVariants,
    clearSets,
    clearRarities,
    clearMoreFilters,
    clearAll,
    totalSelected: selectedVariants.length + selectedSets.length + selectedRarities.length,
    moreFiltersActiveCount,
    activeAxisCount:
      (selectedVariants.length > 0 ? 1 : 0)
      + (selectedSets.length > 0 ? 1 : 0)
      + moreFiltersActiveCount,
  };
}
