import { useCallback, useState } from 'react';
import {
  PERSIST_KEYS,
  SearchScopeSchema,
  StringArraySchema,
  DEFAULTS,
  readPersisted,
  writePersisted,
  clearPersisted,
  type SearchScope,
} from '../persistence';

export type { SearchScope };

function loadSet(key: string): Set<string> {
  return new Set(readPersisted(key, StringArraySchema, []));
}

function saveSet(key: string, set: Set<string>) {
  if (set.size === 0) clearPersisted(key);
  else writePersisted(key, [...set]);
}

/**
 * Per-device filters for search results. Hidden variants and hidden sets
 * are skipped in every search. Nothing is ever filtered from trade
 * panels — a card already in the trade stays visible and editable
 * regardless of the filter.
 */
export function useSearchFilters() {
  const [hiddenVariants, setHiddenVariants] = useState<Set<string>>(
    () => loadSet(PERSIST_KEYS.hideVariants),
  );
  const [hiddenSets, setHiddenSets] = useState<Set<string>>(
    () => loadSet(PERSIST_KEYS.hideSets),
  );
  const [scope, setScopeState] = useState<SearchScope>(
    () => readPersisted(PERSIST_KEYS.searchScope, SearchScopeSchema, DEFAULTS.searchScope),
  );

  const setScope = useCallback((next: SearchScope) => {
    setScopeState(next);
    if (next === DEFAULTS.searchScope) clearPersisted(PERSIST_KEYS.searchScope);
    else writePersisted(PERSIST_KEYS.searchScope, next);
  }, []);

  const toggleVariant = useCallback((variant: string) => {
    setHiddenVariants(prev => {
      const next = new Set(prev);
      if (next.has(variant)) next.delete(variant);
      else next.add(variant);
      saveSet(PERSIST_KEYS.hideVariants, next);
      return next;
    });
  }, []);

  const toggleSet = useCallback((setSlug: string) => {
    setHiddenSets(prev => {
      const next = new Set(prev);
      if (next.has(setSlug)) next.delete(setSlug);
      else next.add(setSlug);
      saveSet(PERSIST_KEYS.hideSets, next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setHiddenVariants(new Set());
    setHiddenSets(new Set());
    saveSet(PERSIST_KEYS.hideVariants, new Set());
    saveSet(PERSIST_KEYS.hideSets, new Set());
  }, []);

  const totalHidden = hiddenVariants.size + hiddenSets.size;

  return {
    hiddenVariants, hiddenSets, scope,
    toggleVariant, toggleSet, setScope, clearAll,
    totalHidden,
  };
}
