import { useCallback, useState } from 'react';
import {
  StringArraySchema,
  readPersisted,
  writePersisted,
  clearPersisted,
} from '../persistence';
import type { CanonicalVariant } from '../variants';

export interface SelectionFilters {
  selectedVariants: CanonicalVariant[];
  selectedSets: string[];
  toggleVariant: (v: CanonicalVariant) => void;
  toggleSet: (slug: string) => void;
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
      const next = (prev as readonly string[]).includes(v)
        ? prev.filter(x => x !== v)
        : [...prev, v];
      save(keys.variants, next);
      return next;
    });
  }, [keys.variants]);

  const toggleSet = useCallback((slug: string) => {
    setSelectedSets(prev => {
      const next = prev.includes(slug)
        ? prev.filter(x => x !== slug)
        : [...prev, slug];
      save(keys.sets, next);
      return next;
    });
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
    clearVariants,
    clearSets,
    clearAll,
    totalSelected: selectedVariants.length + selectedSets.length,
  };
}
