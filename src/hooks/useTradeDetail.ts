import { useCallback, useEffect, useState } from 'react';

export interface CardSnapshot {
  productId: string;
  name: string;
  variant: string;
  qty: number;
  unitPrice: number | null;
}

export type TradeStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'countered';

export interface UserStub {
  handle: string;
  username: string;
  avatarUrl: string | null;
}

export interface ChainStub {
  id: string;
  status: TradeStatus;
}

export interface TradeDetail {
  id: string;
  status: TradeStatus;
  counterOfId: string | null;
  counterOfStub: ChainStub | null;
  counteredByStub: ChainStub | null;
  offeringCards: CardSnapshot[];
  receivingCards: CardSnapshot[];
  message: string | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
  proposer: UserStub | null;
  recipient: UserStub | null;
  viewerIsProposer: boolean;
  viewerIsRecipient: boolean;
}

export interface TradeDetailApi {
  trade: TradeDetail | null;
  status: 'loading' | 'ready' | 'not-found' | 'error';
  cancel: () => Promise<'ok' | 'already-resolved' | 'error'>;
  cancelling: boolean;
  reload: () => void;
}

/**
 * Loads a single proposal by id. Powers /?trade=<id>. Exposes a
 * `cancel` mutation for the proposer-can-retract flow — returns a
 * discriminated result so the UI can show the right message (409
 * race → "already resolved", network error → "try again").
 */
export function useTradeDetail(id: string | null): TradeDetailApi {
  const [trade, setTrade] = useState<TradeDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  const [cancelling, setCancelling] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!id) {
      setStatus('not-found');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(`/api/trades/${encodeURIComponent(id)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setStatus('not-found');
          return;
        }
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const data: TradeDetail = await res.json();
        setTrade(data);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [id, reloadTick]);

  const cancel = useCallback(async (): Promise<'ok' | 'already-resolved' | 'error'> => {
    if (!id || cancelling) return 'error';
    setCancelling(true);
    try {
      const res = await fetch('/api/trades/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.status === 409) return 'already-resolved';
      if (!res.ok) return 'error';
      // Reload to pick up the fresh status + respondedAt timestamp.
      setReloadTick(t => t + 1);
      return 'ok';
    } catch {
      return 'error';
    } finally {
      setCancelling(false);
    }
  }, [id, cancelling]);

  const reload = useCallback(() => setReloadTick(t => t + 1), []);

  return { trade, status, cancel, cancelling, reload };
}
