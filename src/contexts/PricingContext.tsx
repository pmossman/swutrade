import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import {
  PERSIST_KEYS,
  PercentageSchema,
  PriceModeSchema,
  DEFAULTS,
} from '../persistence';
import type { PriceMode } from '../types';

/**
 * Shared pricing-knob state — the trade-adjustment `percentage` and
 * the `priceMode` toggle (Market vs Low). Persisted to localStorage
 * so the user's preference survives reloads; the "Raw" setters bypass
 * localStorage so URL-driven updates (share links, back/forward nav)
 * don't clobber the saved preference.
 *
 * Was prop-drilled through ~10 components before this extraction —
 * App.tsx owned the state and passed it to every view + composer +
 * the TradeBalance / TradeSummary / AutoBalanceBanner surfaces.
 * Moving to context drops the first-layer drilling; deeper child
 * prop chains (e.g., TradeSide → CardTile) stay as-is for now since
 * those are intra-family and not harmful.
 */

interface PricingContextValue {
  percentage: number;
  setPercentage: (v: number) => void;
  /** Bypasses localStorage — used by useTradeUrl so URL restores
   *  don't write back into the persisted knob. */
  setPercentageRaw: (v: number) => void;
  priceMode: PriceMode;
  setPriceMode: (v: PriceMode) => void;
  setPriceModeRaw: (v: PriceMode) => void;
}

const PricingContext = createContext<PricingContextValue | null>(null);

export function PricingProvider({ children }: { children: ReactNode }) {
  const [percentage, setPercentage, setPercentageRaw] = usePersistedState(
    PERSIST_KEYS.percentage,
    PercentageSchema,
    DEFAULTS.percentage,
  );
  const [priceMode, setPriceMode, setPriceModeRaw] = usePersistedState<PriceMode>(
    PERSIST_KEYS.priceMode,
    PriceModeSchema,
    DEFAULTS.priceMode,
  );

  // Memoise the value object so consumers (TradeBalance, TradeSummary,
  // AutoBalanceBanner) only re-render when one of the actual fields
  // changes — not on every parent render that happens to re-call this
  // provider. Setters are stable refs from `usePersistedState`.
  const value = useMemo<PricingContextValue>(
    () => ({
      percentage,
      setPercentage,
      setPercentageRaw,
      priceMode,
      setPriceMode,
      setPriceModeRaw,
    }),
    [percentage, setPercentage, setPercentageRaw, priceMode, setPriceMode, setPriceModeRaw],
  );

  return (
    <PricingContext.Provider value={value}>
      {children}
    </PricingContext.Provider>
  );
}

export function usePricing(): PricingContextValue {
  const ctx = useContext(PricingContext);
  if (!ctx) throw new Error('usePricing must be used inside a <PricingProvider>');
  return ctx;
}
