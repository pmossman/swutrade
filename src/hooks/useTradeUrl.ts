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
  if (state.percentage !== 80) params.set('pct', String(state.percentage));
  if (state.priceMode !== 'market') params.set('pm', 'l');
  return params.toString();
}

function parseUrl(): { pending: PendingCards; percentage: number; priceMode: PriceMode } | null {
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
    percentage: pct ? parseInt(pct, 10) || 80 : 80,
    priceMode: pm === 'l' ? 'low' : 'market',
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
      pendingRef.current = parsed.pending;
      suppressPushRef.current = true;
      setPercentage(parsed.percentage);
      setPriceMode(parsed.priceMode);
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
      setPercentage(80);
      setPriceMode('market');
      return;
    }

    setPercentage(parsed.percentage);
    setPriceMode(parsed.priceMode);
    setYourCards(resolveCards(parsed.pending.yours, cardMap));
    setTheirCards(resolveCards(parsed.pending.theirs, cardMap));
  }, [allCards, setYourCards, setTheirCards, setPercentage, setPriceMode]);

  useEffect(() => {
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [handlePopState]);
}
