import { createContext, useContext, useMemo } from 'react';
import type { CardVariant } from '../types';
import { cardFamilyId } from '../variants';
import { usePriceDataContext } from './PriceDataContext';

/**
 * Cross-printing indexes derived from the price catalog. Lives below
 * `<PriceDataProvider>` so it can read the catalog. Before this context
 * each view that needed card-by-family or card-by-product lookups either
 * got the maps prop-drilled from App.tsx or rebuilt its own copy
 * (HomeView, ListsDrawer) — the duplication was the root of the
 * "ListsDrawer rendered familyId slugs" regression.
 */
export interface CardIndexContextValue {
  byFamily: Map<string, CardVariant>;
  byFamilyAll: Map<string, CardVariant[]>;
  byProductId: Map<string, CardVariant>;
  allLoadedCards: CardVariant[];
}

const CardIndexContext = createContext<CardIndexContextValue | null>(null);

export function CardIndexProvider({ children }: { children: React.ReactNode }) {
  const { cards } = usePriceDataContext();
  const value = useMemo<CardIndexContextValue>(() => {
    const allLoadedCards: CardVariant[] = Object.values(cards).flat();
    const byFamily = new Map<string, CardVariant>();
    const byFamilyAll = new Map<string, CardVariant[]>();
    const byProductId = new Map<string, CardVariant>();
    for (const card of allLoadedCards) {
      if (card.productId) byProductId.set(card.productId, card);
      const fid = cardFamilyId(card);
      const existing = byFamily.get(fid);
      if (!existing || card.variant === 'Standard') byFamily.set(fid, card);
      const bucket = byFamilyAll.get(fid);
      if (bucket) bucket.push(card);
      else byFamilyAll.set(fid, [card]);
    }
    return { byFamily, byFamilyAll, byProductId, allLoadedCards };
  }, [cards]);
  return <CardIndexContext.Provider value={value}>{children}</CardIndexContext.Provider>;
}

export function useCardIndexContext(): CardIndexContextValue {
  const ctx = useContext(CardIndexContext);
  if (!ctx) throw new Error('useCardIndexContext must be used inside CardIndexProvider');
  return ctx;
}
