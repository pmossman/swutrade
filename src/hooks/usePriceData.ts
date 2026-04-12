import { useState, useCallback, useRef, useEffect } from 'react';
import type { CardVariant, SetInfo } from '../types';
import { SETS } from '../types';
import { fetchSetPrices, fetchManifest } from '../services/priceService';

interface PriceDataState {
  cards: Record<string, CardVariant[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
  priceTimestamp: string | null;
}

export function usePriceData() {
  const [state, setState] = useState<PriceDataState>({
    cards: {},
    loading: {},
    errors: {},
    priceTimestamp: null,
  });

  // Track which sets are loaded or in-flight to avoid duplicate fetches
  const loadedRef = useRef<Set<string>>(new Set());

  // Load the manifest timestamp on mount
  useEffect(() => {
    fetchManifest()
      .then(m => setState(prev => ({ ...prev, priceTimestamp: m.timestamp })))
      .catch(() => {}); // Non-critical
  }, []);

  const loadSet = useCallback(async (set: SetInfo) => {
    if (loadedRef.current.has(set.slug)) return;
    loadedRef.current.add(set.slug);

    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, [set.slug]: true },
      errors: { ...prev.errors, [set.slug]: null },
    }));

    try {
      const data = await fetchSetPrices(set);
      setState(prev => ({
        ...prev,
        cards: { ...prev.cards, [set.slug]: data },
        loading: { ...prev.loading, [set.slug]: false },
      }));
    } catch (err: any) {
      loadedRef.current.delete(set.slug); // Allow retry
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, [set.slug]: false },
        errors: { ...prev.errors, [set.slug]: err.message },
      }));
    }
  }, []);

  const loadAllSets = useCallback(async () => {
    // Load all known sets from types
    SETS.forEach(set => loadSet(set));

    // Also load any dynamically discovered sets from the manifest
    try {
      const manifest = await fetchManifest();
      for (const slug of Object.keys(manifest.sets)) {
        if (!SETS.find(s => s.slug === slug)) {
          // Discovered set not in types — load it with a generated SetInfo
          loadSet({ slug, code: slug.toUpperCase().slice(0, 4), name: slug.replace(/-/g, ' '), category: 'promo' });
        }
      }
    } catch {
      // Non-critical — we still have all known sets
    }
  }, [loadSet]);

  const retrySet = useCallback((set: SetInfo) => {
    loadedRef.current.delete(set.slug);
    loadSet(set);
  }, [loadSet]);

  const getAllCards = useCallback((): CardVariant[] => {
    return Object.values(state.cards).flat();
  }, [state.cards]);

  const getSetCards = useCallback((slug: string): CardVariant[] => {
    return state.cards[slug] || [];
  }, [state.cards]);

  const isAnyLoading = Object.values(state.loading).some(Boolean);

  return {
    ...state,
    loadSet,
    loadAllSets,
    retrySet,
    getAllCards,
    getSetCards,
    isAnyLoading,
  };
}
