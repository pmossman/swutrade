import { useCallback, useEffect, useState } from 'react';
import { PERSIST_KEYS } from '../persistence/schemas';

export type TradeViewMode = 'split' | 'tabbed';

const DEFAULT_MODE: TradeViewMode = 'split';

function readPersisted(): TradeViewMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(PERSIST_KEYS.tradeViewMode);
    return raw === 'tabbed' ? 'tabbed' : 'split';
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * Per-device toggle between the long-standing side-by-side trade
 * layout and a single-focus tabbed layout. Default stays `split` so
 * existing users don't see a surprise layout change; new beta
 * feedback users can flip to `tabbed` when the two-panel view feels
 * cramped on phones.
 *
 * Persistence is intentionally device-local (plain localStorage,
 * not synced to the user's server profile) — a phone user's "tabs"
 * preference shouldn't change what they see on the desktop they
 * open later.
 */
export function useTradeViewMode(): {
  mode: TradeViewMode;
  setMode: (next: TradeViewMode) => void;
  toggle: () => void;
} {
  const [mode, setModeState] = useState<TradeViewMode>(readPersisted);

  // Cross-tab sync — if the user toggles in one tab, other tabs
  // update on next render without needing a reload.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== PERSIST_KEYS.tradeViewMode) return;
      setModeState(e.newValue === 'tabbed' ? 'tabbed' : 'split');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setMode = useCallback((next: TradeViewMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(PERSIST_KEYS.tradeViewMode, next);
    } catch {
      // localStorage unavailable (private browsing, quota) — keep the
      // in-memory value; don't block the toggle on persistence.
    }
  }, []);

  const toggle = useCallback(() => {
    setMode(mode === 'split' ? 'tabbed' : 'split');
  }, [mode, setMode]);

  return { mode, setMode, toggle };
}
