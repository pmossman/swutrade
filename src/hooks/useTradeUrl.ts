import { useEffect, useRef, useCallback } from 'react';
import type { TradeCard, CardVariant, PriceMode } from '../types';

interface TradeUrlState {
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
}

interface PendingCards {
  yours: { productId: string; qty: number }[];
  theirs: { productId: string; qty: number }[];
}

function encodeCards(cards: TradeCard[]): string {
  return cards
    .filter(tc => tc.card.productId)
    .map(tc => `${tc.card.productId}.${tc.qty}`)
    .join(',');
}

function decodeCardRefs(param: string): { productId: string; qty: number }[] {
  if (!param) return [];
  return param.split(',').filter(Boolean).map(entry => {
    const [productId, qtyStr] = entry.split('.');
    return { productId, qty: parseInt(qtyStr, 10) || 1 };
  });
}

function buildSearch(state: TradeUrlState): string {
  const params = new URLSearchParams();
  const y = encodeCards(state.yourCards);
  const t = encodeCards(state.theirCards);
  if (y) params.set('y', y);
  if (t) params.set('t', t);
  // When there's a trade, always encode pm/pct so share links carry the
  // sharer's intent rather than picking up the receiver's persisted prefs.
  // When there's no trade, omit them so the bare URL stays clean and
  // localStorage preferences remain authoritative.
  const hasTrade = Boolean(y || t);
  if (hasTrade || state.percentage !== 80) params.set('pct', String(state.percentage));
  if (hasTrade || state.priceMode !== 'market') {
    params.set('pm', state.priceMode === 'low' ? 'l' : 'm');
  }
  return params.toString();
}

function parseUrl(): {
  pending: PendingCards;
  percentage: number | null;
  priceMode: PriceMode | null;
} | null {
  const params = new URLSearchParams(window.location.search);
  const y = params.get('y');
  const t = params.get('t');
  const pct = params.get('pct');
  const pm = params.get('pm');

  if (!y && !t && !pct && !pm) return null;

  return {
    pending: {
      yours: decodeCardRefs(y || ''),
      theirs: decodeCardRefs(t || ''),
    },
    // null means "URL didn't specify — leave current (persisted) value alone"
    percentage: pct ? parseInt(pct, 10) || 80 : null,
    priceMode: pm === 'l' ? 'low' : pm === 'm' ? 'market' : null,
  };
}

function resolveCards(
  refs: { productId: string; qty: number }[],
  cardMap: Map<string, CardVariant>,
): TradeCard[] {
  const resolved: TradeCard[] = [];
  for (const ref of refs) {
    const card = cardMap.get(ref.productId);
    if (card) resolved.push({ card, qty: ref.qty });
  }
  return resolved;
}

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
    const parsed = parseUrl();
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
    const cardMap = new Map<string, CardVariant>();
    for (const card of allCards) {
      if (card.productId) cardMap.set(card.productId, card);
    }

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

    const search = buildSearch(state);
    const newUrl = search ? `?${search}` : window.location.pathname;
    const currentSearch = window.location.search.replace(/^\?/, '');

    // While pending card references are still waiting on price data to
    // load, don't rewrite the URL to drop them. Otherwise the mount →
    // first-render → state-sync cycle wipes the y/t params before the
    // resolver gets a chance, and a refresh mid-window loses the trade.
    if (pendingRef.current) {
      const currentParams = new URLSearchParams(currentSearch);
      const newParams = new URLSearchParams(search);
      const wouldDropY = currentParams.get('y') && !newParams.get('y');
      const wouldDropT = currentParams.get('t') && !newParams.get('t');
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
    const parsed = parseUrl();
    suppressPushRef.current = true;

    const cardMap = new Map<string, CardVariant>();
    for (const card of allCards) {
      if (card.productId) cardMap.set(card.productId, card);
    }

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
