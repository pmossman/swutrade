import { useCallback, useState } from 'react';
import {
  StringArraySchema,
  readPersisted,
  writePersisted,
  clearPersisted,
} from '../persistence';
import type { CanonicalVariant } from '../variants';

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
  toggleVariant: (v: CanonicalVariant) => void;
  toggleSet: (slug: string) => void;
  /** Swap the active set-group pseudo-slug, ensuring the two known
   *  group slugs ('group:main' and 'group:special') stay mutually
   *  exclusive. Pass null to clear the group while leaving any
   *  individual set chips intact. */
  replaceGroup: (group: string | null) => void;
  clearVariants: () => void;
  clearSets: () => void;
  clearAll: () => void;
  totalSelected: number;
}

interface Keys {
  variants: string;
  sets: string;
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
export function useSelectionFilters(keys: Keys): SelectionFilters {
  const [selectedVariants, setSelectedVariants] = useState<CanonicalVariant[]>(
    () => loadArray<CanonicalVariant>(keys.variants),
  );
  const [selectedSets, setSelectedSets] = useState<string[]>(
    () => loadArray<string>(keys.sets),
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

  const clearVariants = useCallback(() => {
    setSelectedVariants([]);
    save(keys.variants, []);
  }, [keys.variants]);

  const clearSets = useCallback(() => {
    setSelectedSets([]);
    save(keys.sets, []);
  }, [keys.sets]);

  const clearAll = useCallback(() => {
    setSelectedVariants([]);
    setSelectedSets([]);
    save(keys.variants, []);
    save(keys.sets, []);
  }, [keys.variants, keys.sets]);

  return {
    selectedVariants,
    selectedSets,
    toggleVariant,
    toggleSet,
    replaceGroup,
    clearVariants,
    clearSets,
    clearAll,
    totalSelected: selectedVariants.length + selectedSets.length,
  };
}
