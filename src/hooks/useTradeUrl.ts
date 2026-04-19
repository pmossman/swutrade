import { useEffect, useRef, useCallback } from 'react';
import type { TradeCard, CardVariant, PriceMode } from '../types';
import {
  buildTradeSearch,
  parseTradeUrl,
  resolveCards,
  buildCardMap,
  type TradeUrlState,
  type PendingCards,
} from '../urlCodec';
import { isStandaloneView, TRADE_CODEC_KEYS } from '../routing/config';

export function useTradeUrl(
  state: TradeUrlState,
  allCards: CardVariant[],
  setYourCards: (cards: TradeCard[]) => void,
  setTheirCards: (cards: TradeCard[]) => void,
  setPercentage: (pct: number) => void,
  setPriceMode: (mode: PriceMode) => void,
) {
  const pendingRef = useRef<PendingCards | null>(null);
  const initializedRef = useRef(false);
  // When true, URL sync uses replaceState instead of pushState (no new history entry)
  const suppressPushRef = useRef(false);

  // On mount, parse URL for pending card references
  useEffect(() => {
    const parsed = parseTradeUrl(window.location.search.replace(/^\?/, ''));
    if (parsed) {
      // Only track pending if there's actually something to resolve.
      // Otherwise the later-resolve effect bails early on empty allCards
      // and pendingRef stays set forever, which wedges URL sync.
      const hasPending = parsed.pending.yours.length > 0 || parsed.pending.theirs.length > 0;
      if (hasPending) pendingRef.current = parsed.pending;
      suppressPushRef.current = true;
      // null means URL didn't specify — keep the persisted value.
      if (parsed.percentage !== null) setPercentage(parsed.percentage);
      if (parsed.priceMode !== null) setPriceMode(parsed.priceMode);
    }
    initializedRef.current = true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Once price data loads, resolve pending productIds to full cards
  useEffect(() => {
    if (!pendingRef.current || allCards.length === 0) return;

    const pending = pendingRef.current;
    const cardMap = buildCardMap(allCards);

    const yours = resolveCards(pending.yours, cardMap);
    const theirs = resolveCards(pending.theirs, cardMap);

    if (yours.length > 0 || theirs.length > 0) {
      suppressPushRef.current = true;
      setYourCards(yours);
      setTheirCards(theirs);
    }

    const allResolved =
      pending.yours.every(r => cardMap.has(r.productId)) &&
      pending.theirs.every(r => cardMap.has(r.productId));

    if (allResolved) {
      pendingRef.current = null;
    }
  }, [allCards, setYourCards, setTheirCards]);

  // Sync state changes to URL
  useEffect(() => {
    if (!initializedRef.current) return;

    // Don't rewrite the URL when we're on a stand-alone view that
    // owns params useTradeUrl doesn't understand. Each of these is
    // a view mode detected by routing/config; stripping their query
    // params would misroute on reload (and in fact has, previously —
    // the ?autoBalance=1 trap + the ?trade=<id> trap both trace to
    // this effect). Consulting VIEW_ROUTES via isStandaloneView()
    // keeps detection + param-preservation in sync — add a new
    // stand-alone view there, get the guard for free.
    const currentParams = new URLSearchParams(window.location.search);
    if (isStandaloneView({
      pathname: window.location.pathname,
      params: currentParams,
      // Trade-codec sync is identity-agnostic; the signed-in flag
      // only matters for bare-URL routing (home vs trade fallback),
      // neither of which is a stand-alone view.
      isSignedIn: false,
    })) {
      return;
    }

    // Build the trade-codec params and MERGE them into the existing
    // search string rather than replacing it wholesale. Without this
    // merge, context params like `propose`, `from`, `counter` get
    // stripped on every card add — within a session the React-state
    // hooks (useProposeHandle etc.) cushion it via lazy init, but
    // refresh loses the context (ProposeBar unmounts, Send button
    // disappears) while the cards themselves restore. Real bug.
    const tradeOnlySearch = buildTradeSearch(state);
    const tradeParams = new URLSearchParams(tradeOnlySearch);
    const merged = new URLSearchParams(window.location.search);
    for (const key of TRADE_CODEC_KEYS) {
      const value = tradeParams.get(key);
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    const search = merged.toString();
    const newUrl = search ? `?${search}` : window.location.pathname;
    const currentSearch = window.location.search.replace(/^\?/, '');

    // While pending card references are still waiting on price data to
    // load, don't rewrite the URL to drop them. Otherwise the mount →
    // first-render → state-sync cycle wipes the y/t params before the
    // resolver gets a chance, and a refresh mid-window loses the trade.
    if (pendingRef.current) {
      const currentParams = new URLSearchParams(currentSearch);
      const wouldDropY = currentParams.get('y') && !merged.get('y');
      const wouldDropT = currentParams.get('t') && !merged.get('t');
      if (wouldDropY || wouldDropT) return;
    }

    if (search !== currentSearch) {
      if (suppressPushRef.current) {
        suppressPushRef.current = false;
        window.history.replaceState(null, '', newUrl);
      } else {
        window.history.pushState(null, '', newUrl);
      }
    } else {
      // URL matches, clear suppress flag
      suppressPushRef.current = false;
    }
  }, [state]);

  // Handle back/forward navigation
  const handlePopState = useCallback(() => {
    const parsed = parseTradeUrl(window.location.search.replace(/^\?/, ''));
    suppressPushRef.current = true;

    const cardMap = buildCardMap(allCards);

    if (!parsed) {
      setYourCards([]);
      setTheirCards([]);
      // Don't reset pm/pct on popstate to a bare URL — the user's persisted
      // prefs should stand. The setter here is the raw setter so it won't
      // overwrite localStorage anyway.
      return;
    }

    if (parsed.percentage !== null) setPercentage(parsed.percentage);
    if (parsed.priceMode !== null) setPriceMode(parsed.priceMode);
    setYourCards(resolveCards(parsed.pending.yours, cardMap));
    setTheirCards(resolveCards(parsed.pending.theirs, cardMap));
  }, [allCards, setYourCards, setTheirCards, setPercentage, setPriceMode]);

  useEffect(() => {
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [handlePopState]);
}
