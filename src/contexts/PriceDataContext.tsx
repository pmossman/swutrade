import { createContext, useContext, useEffect } from 'react';
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
  const value: PriceDataContextValue = {
    cards: priceData.cards,
    loading: priceData.loading,
    errors: priceData.errors,
    priceTimestamp: priceData.priceTimestamp,
    isAnyLoading: priceData.isAnyLoading,
    loadSet: priceData.loadSet,
    loadAllSets: priceData.loadAllSets,
    retrySet: priceData.retrySet,
  };
  return <PriceDataContext.Provider value={value}>{children}</PriceDataContext.Provider>;
}

export function usePriceDataContext(): PriceDataContextValue {
  const ctx = useContext(PriceDataContext);
  if (!ctx) throw new Error('usePriceDataContext must be used inside PriceDataProvider');
  return ctx;
}
