import { useEffect, useState } from 'react';
import type { TradeStatus, UserStub } from './useTradeDetail';

export interface TradeListEntry {
  id: string;
  direction: 'sent' | 'received';
  status: TradeStatus;
  counterOfId: string | null;
  offeringCount: number;
  receivingCount: number;
  hasMessage: boolean;
  counterpart: UserStub | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
}

export interface TradesListApi {
  proposals: TradeListEntry[];
  status: 'loading' | 'ready' | 'error';
}

/**
 * Lists proposals the signed-in viewer is involved in. One-shot
 * fetch — the history page remounts on each visit, which is good
 * enough for MVP. Add a refresh button if this turns out to hurt.
 */
export function useTradesList(): TradesListApi {
  const [proposals, setProposals] = useState<TradeListEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/trades/proposals');
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: { proposals: TradeListEntry[] } = await res.json();
        if (cancelled) return;
        setProposals(data.proposals);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { proposals, status };
}
