import { useCallback, useEffect, useState } from 'react';

/**
 * Unified owner of the "trade intent" query-param signals. One hook
 * replaces what used to be five separate lazy-init hooks + an inline
 * URL read in AutoBalanceBanner, each of which only captured its value
 * on first mount. That pattern meant in-app `pushState` navigation to
 * a URL carrying one of these params was silently ignored — only a
 * full-page reload or a URL entered at load time ever activated the
 * intent. Reported by Parker after noticing Home → HandlePickerDialog
 * set `?propose=<handle>` but ProposeBar never rendered.
 *
 * The contract now:
 *
 *   - State is seeded from the URL on mount (preserves reload + shared
 *     URL behavior — opening `/?propose=alice` still enters propose
 *     mode for the first render).
 *   - `popstate` (browser back/forward) re-syncs state to whatever the
 *     URL now says.
 *   - In-app navigation helpers call `setIntent(patch)` alongside their
 *     `pushState` write, so state and URL stay in lockstep without
 *     depending on the hook noticing the URL change.
 *   - `useTradeUrl` still strips these params from the visible URL
 *     shortly after mount, but the captured state outlives the strip —
 *     we don't re-read the URL except on popstate.
 *
 * The five tracked intents are the union of what used to live in
 * useProposeHandle, useSenderHandle, useCounterId, useEditId, and the
 * inline `autoBalance=1` check in AutoBalanceBanner. `w` + `a` shared-
 * list payloads live in `useSharedLists` — same seed + popstate
 * contract, just decoded arrays instead of scalars.
 */
export interface TradeIntent {
  /** `?propose=<handle>` — open ProposeBar with this recipient. */
  propose: string | null;
  /** `?from=<handle>` — matchmaker / shared-list sender context. */
  from: string | null;
  /** `?counter=<tradeId>` — open CounterBar against this proposal. */
  counter: string | null;
  /** `?edit=<tradeId>` — open EditBar on this pending proposal. */
  edit: string | null;
  /** `?autoBalance=1` — one-shot "apply a balance suggestion now"
   *  signal set by ProfileView's "Balanced trade with @X" CTA. */
  autoBalance: boolean;
}

export interface TradeIntentApi extends TradeIntent {
  /** Merge a partial patch into the intent state. Pass `null` to clear
   *  a field explicitly. Callers pair this with a `pushState` to the
   *  matching URL; the two updates together keep state + URL aligned. */
  setIntent: (patch: Partial<TradeIntent>) => void;
  /** Clear every intent — used by navigations out of the trade view
   *  (Home, Community, Settings, etc.). */
  clearIntent: () => void;
}

function readHandle(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^@+/, '');
  return trimmed || null;
}

function readId(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/** Empty intent — exported so callers (tests, reset helpers) don't
 *  redeclare the shape. */
export const EMPTY_INTENT: TradeIntent = {
  propose: null,
  from: null,
  counter: null,
  edit: null,
  autoBalance: false,
};

/** Pure URL → intent parse. Exported so the reducer is testable
 *  without a React test runner. */
export function parseIntentFromSearch(search: string): TradeIntent {
  const p = new URLSearchParams(search);
  return {
    propose: readHandle(p.get('propose')),
    from: readHandle(p.get('from')),
    counter: readId(p.get('counter')),
    edit: readId(p.get('edit')),
    autoBalance: p.get('autoBalance') === '1',
  };
}

function readFromUrl(): TradeIntent {
  if (typeof window === 'undefined') return EMPTY_INTENT;
  return parseIntentFromSearch(window.location.search);
}

export function useTradeIntent(): TradeIntentApi {
  const [state, setState] = useState<TradeIntent>(() => readFromUrl());

  // Browser back/forward rewrites the URL without touching React state,
  // so re-sync explicitly. The imperative setIntent path is what keeps
  // pushState-driven in-app navigation working; popstate handles the
  // mirror case (user retreats to a URL whose intent has changed).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => setState(readFromUrl());
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const setIntent = useCallback((patch: Partial<TradeIntent>) => {
    setState(prev => ({ ...prev, ...patch }));
  }, []);

  const clearIntent = useCallback(() => {
    setState({ propose: null, from: null, counter: null, edit: null, autoBalance: false });
  }, []);

  return { ...state, setIntent, clearIntent };
}
