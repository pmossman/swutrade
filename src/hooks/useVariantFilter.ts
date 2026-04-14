import { useCallback, useState } from 'react';

const VARIANT_KEY = 'swu.hideVariants';
const SET_KEY = 'swu.hideSets';
const SCOPE_KEY = 'swu.searchScope';

export type SearchScope = 'all' | 'main' | 'promo';

function loadScope(): SearchScope {
  if (typeof window === 'undefined') return 'all';
  try {
    const raw = window.localStorage.getItem(SCOPE_KEY);
    if (raw === 'main' || raw === 'promo' || raw === 'all') return raw;
    return 'all';
  } catch {
    return 'all';
  }
}

function loadSet(key: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveSet(key: string, set: Set<string>) {
  try {
    if (set.size === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // Persistence best-effort; filters just won't survive reload.
  }
}

/**
 * Per-device filters for search results. Hidden variants and hidden sets
 * are skipped in every search. Nothing is ever filtered from trade
 * panels — a card already in the trade stays visible and editable
 * regardless of the filter.
 */
export function useSearchFilters() {
  const [hiddenVariants, setHiddenVariants] = useState<Set<string>>(() => loadSet(VARIANT_KEY));
  const [hiddenSets, setHiddenSets] = useState<Set<string>>(() => loadSet(SET_KEY));
  const [scope, setScopeState] = useState<SearchScope>(loadScope);

  const setScope = useCallback((next: SearchScope) => {
    setScopeState(next);
    try {
      if (next === 'all') window.localStorage.removeItem(SCOPE_KEY);
      else window.localStorage.setItem(SCOPE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const toggleVariant = useCallback((variant: string) => {
    setHiddenVariants(prev => {
      const next = new Set(prev);
      if (next.has(variant)) next.delete(variant);
      else next.add(variant);
      saveSet(VARIANT_KEY, next);
      return next;
    });
  }, []);

  const toggleSet = useCallback((setSlug: string) => {
    setHiddenSets(prev => {
      const next = new Set(prev);
      if (next.has(setSlug)) next.delete(setSlug);
      else next.add(setSlug);
      saveSet(SET_KEY, next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setHiddenVariants(new Set());
    setHiddenSets(new Set());
    saveSet(VARIANT_KEY, new Set());
    saveSet(SET_KEY, new Set());
  }, []);

  const totalHidden = hiddenVariants.size + hiddenSets.size;

  return {
    hiddenVariants, hiddenSets, scope,
    toggleVariant, toggleSet, setScope, clearAll,
    totalHidden,
  };
}
