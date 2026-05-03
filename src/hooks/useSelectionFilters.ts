import { useCallback, useState } from 'react';
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

export interface SelectionFilters {
  selectedVariants: CanonicalVariant[];
  selectedSets: string[];
  selectedRarities: SelectableRarity[];
  sortBy: SortBy;
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

  return {
    selectedVariants,
    selectedSets,
    selectedRarities,
    sortBy,
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
  };
}
