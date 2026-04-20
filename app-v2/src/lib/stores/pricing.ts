import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PriceMode = 'market' | 'low';

interface PricingStore {
  /** Negotiation percentage (1–100). Defaults to 80 — the most common
   *  opener in SWU trading and v1's shipped default. */
  pct: number;
  setPct: (pct: number) => void;

  /** Market vs low price mode. Affects new-card snapshots only in
   *  Phase 1; v1's URL-codec override semantics for received shares
   *  ship in a later sub-phase. */
  mode: PriceMode;
  setMode: (mode: PriceMode) => void;
}

export const usePricingStore = create<PricingStore>()(
  persist(
    (set) => ({
      pct: 80,
      setPct: (pct) => set({ pct: Math.max(1, Math.min(100, Math.round(pct))) }),
      mode: 'market',
      setMode: (mode) => set({ mode }),
    }),
    {
      name: 'swu-v2-pricing',
      partialize: (state) => ({ pct: state.pct, mode: state.mode }),
    },
  ),
);
