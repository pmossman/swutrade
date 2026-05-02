import { createContext, useContext, useEffect, useMemo } from 'react';
import type { CardVariant, SetInfo } from '../types';
import { usePriceData } from '../hooks/usePriceData';

export interface PriceDataContextValue {
  cards: Record<string, CardVariant[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
  priceTimestamp: string | null;
  isAnyLoading: boolean;
  loadSet: (set: SetInfo) => Promise<void>;
  loadAllSets: () => Promise<void>;
  retrySet: (set: SetInfo) => void;
}

const PriceDataContext = createContext<PriceDataContextValue | null>(null);

export function PriceDataProvider({ children }: { children: React.ReactNode }) {
  const priceData = usePriceData();
  useEffect(() => {
    priceData.loadAllSets();
  }, [priceData.loadAllSets]);
  // Memoize so the provider doesn't ship a fresh object literal each
  // render — every `usePriceDataContext()` consumer would otherwise
  // re-render on every parent re-render (60s minute-tick, useSession
  // poll setStates, etc.). usePriceData's primitives are the keys.
  const value = useMemo<PriceDataContextValue>(
    () => ({
      cards: priceData.cards,
      loading: priceData.loading,
      errors: priceData.errors,
      priceTimestamp: priceData.priceTimestamp,
      isAnyLoading: priceData.isAnyLoading,
      loadSet: priceData.loadSet,
      loadAllSets: priceData.loadAllSets,
      retrySet: priceData.retrySet,
    }),
    [
      priceData.cards,
      priceData.loading,
      priceData.errors,
      priceData.priceTimestamp,
      priceData.isAnyLoading,
      priceData.loadSet,
      priceData.loadAllSets,
      priceData.retrySet,
    ],
  );
  return <PriceDataContext.Provider value={value}>{children}</PriceDataContext.Provider>;
}

export function usePriceDataContext(): PriceDataContextValue {
  const ctx = useContext(PriceDataContext);
  if (!ctx) throw new Error('usePriceDataContext must be used inside PriceDataProvider');
  return ctx;
}
