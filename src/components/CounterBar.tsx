import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardVariant, PriceMode, TradeCard } from '../types';
import {
  adjustPrice,
  getCardPrice,
} from '../services/priceService';
import { extractVariantLabel } from '../variants';

interface CardSnapshot {
  productId: string;
  name: string;
  variant: string;
  qty: number;
  unitPrice: number | null;
}

interface CounterBarProps {
  originalTradeId: string;
  byProductId: Map<string, CardVariant>;
  percentage: number;
  priceMode: PriceMode;
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  onApplyMatch: (yours: TradeCard[], theirs: TradeCard[]) => void;
}

interface OriginalTradeResponse {
  id: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'countered';
  offeringCards: CardSnapshot[];
  receivingCards: CardSnapshot[];
  message: string | null;
  proposer: { handle: string; username: string; avatarUrl: string | null } | null;
  recipient: { handle: string; username: string; avatarUrl: string | null } | null;
  viewerIsRecipient: boolean;
}

type SendState = 'idle' | 'sending' | 'sent' | 'sent-undelivered' | 'already-resolved' | 'error';

/**
 * Sticky bar for `/?counter=<id>`. Sibling of ProposeBar — distinct
 * enough in lifecycle (loads an existing trade instead of a user
 * profile, seeds by flipping sides rather than running the
 * matchmaker) that sharing the component would be messier than
 * two focused siblings.
 *
 * Flow:
 *   1. On mount, GET /api/trades/:id (viewer-is-recipient guard
 *      server-side).
 *   2. If the original is still pending AND viewer is the recipient,
 *      seed the trade sides with swapped cards (original.receiving
 *      → this.offering, original.offering → this.receiving).
 *   3. User adjusts, Send → POST /api/trades/counter. Server
 *      transitions original → 'countered' + inserts the new row.
 *   4. On 409 (original resolved mid-compose) show an explicit
 *      "beaten to the punch" message, not the generic error state.
 */
export function CounterBar({
  originalTradeId,
  byProductId,
  percentage,
  priceMode,
  yourCards,
  theirCards,
  onApplyMatch,
}: CounterBarProps) {
  const [original, setOriginal] = useState<OriginalTradeResponse | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'forbidden' | 'not-found' | 'error' | 'not-recipient' | 'not-pending'>('loading');
  const [sendState, setSendState] = useState<SendState>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [messageOpen, setMessageOpen] = useState(false);
  const autoAppliedRef = useRef(false);
  const fetchStartedRef = useRef(false);

  // One-shot fetch.
  useEffect(() => {
    if (!originalTradeId || fetchStartedRef.current) return;
    fetchStartedRef.current = true;

    let cancelled = false;
    setLoadState('loading');
    (async () => {
      try {
        const res = await fetch(`/api/trades/${encodeURIComponent(originalTradeId)}`);
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setLoadState('forbidden');
          return;
        }
        if (res.status === 404) {
          setLoadState('not-found');
          return;
        }
        if (!res.ok) {
          setLoadState('error');
          return;
        }
        const data: OriginalTradeResponse = await res.json();
        if (cancelled) return;
        if (!data.viewerIsRecipient) {
          setLoadState('not-recipient');
          return;
        }
        if (data.status !== 'pending') {
          setLoadState('not-pending');
          setOriginal(data);
          return;
        }
        setOriginal(data);
        setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [originalTradeId]);

  // Seed the trade panels once we have the original AND the card
  // index is populated. Swaps sides: the recipient's counter offers
  // what was originally asked for, and receives what was offered.
  // Auto-apply is a one-shot — subsequent edits by the user aren't
  // re-overridden by this effect.
  const seeded = useMemo(() => {
    if (!original) return null;
    if (byProductId.size === 0) return null;
    const toTradeCards = (snaps: CardSnapshot[]): TradeCard[] => {
      const out: TradeCard[] = [];
      for (const s of snaps) {
        const card = byProductId.get(s.productId);
        if (card) out.push({ card, qty: s.qty });
      }
      return out;
    };
    return {
      yours: toTradeCards(original.receivingCards),
      theirs: toTradeCards(original.offeringCards),
    };
  }, [original, byProductId]);

  useEffect(() => {
    if (autoAppliedRef.current) return;
    if (!seeded) return;
    if (seeded.yours.length === 0 && seeded.theirs.length === 0) return;
    autoAppliedRef.current = true;
    onApplyMatch(seeded.yours, seeded.theirs);
  }, [seeded, onApplyMatch]);

  const handleSend = useCallback(async () => {
    if (sendState === 'sending' || sendState === 'sent' || sendState === 'sent-undelivered') return;
    if (yourCards.length === 0 && theirCards.length === 0) return;

    setSendState('sending');
    setSendError(null);

    const snapshot = (cards: TradeCard[]) =>
      cards.map(tc => ({
        productId: tc.card.productId ?? '',
        name: tc.card.name.replace(/\s*\([^)]+\)\s*$/, ''),
        variant: extractVariantLabel(tc.card.name) || tc.card.variant || 'Standard',
        qty: tc.qty,
        unitPrice: adjustPrice(getCardPrice(tc.card, priceMode), percentage),
      }));

    try {
      const res = await fetch('/api/trades/counter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          counterOfId: originalTradeId,
          offeringCards: snapshot(yourCards),
          receivingCards: snapshot(theirCards),
          ...(message.trim() ? { message: message.trim() } : {}),
        }),
      });
      if (res.status === 409) {
        setSendState('already-resolved');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data: { id: string; deliveryStatus?: 'delivered' | 'failed' } = await res.json();
      setSendState(data.deliveryStatus === 'failed' ? 'sent-undelivered' : 'sent');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
      setSendState('error');
    }
  }, [sendState, yourCards, theirCards, originalTradeId, percentage, priceMode, message]);

  const proposerHandle = original?.proposer?.handle ?? null;
  const offerCount = yourCards.reduce((n, c) => n + c.qty, 0);
  const receiveCount = theirCards.reduce((n, c) => n + c.qty, 0);

  const body = (() => {
    if (loadState === 'loading') {
      return <span className="flex-1 min-w-0 text-gray-400 animate-pulse">Loading the original proposal…</span>;
    }
    if (loadState === 'not-found' || loadState === 'forbidden') {
      return (
        <span className="flex-1 min-w-0 text-red-300">
          Couldn't load the original proposal — it may have been cancelled or sent to someone else.
        </span>
      );
    }
    if (loadState === 'not-recipient') {
      return (
        <span className="flex-1 min-w-0 text-red-300">
          Only the recipient of a proposal can counter it.
        </span>
      );
    }
    if (loadState === 'not-pending' && original) {
      return (
        <span className="flex-1 min-w-0 text-amber-200">
          This proposal is already <strong>{original.status}</strong> — you can't counter it anymore.
        </span>
      );
    }
    if (loadState === 'error') {
      return <span className="flex-1 min-w-0 text-red-300">Couldn't load the proposal. Try refreshing.</span>;
    }

    if (sendState === 'sent' || sendState === 'sent-undelivered') {
      const undelivered = sendState === 'sent-undelivered';
      return (
        <>
          <span className={`flex-1 ${undelivered ? 'text-amber-200' : 'text-emerald-300'}`}>
            {undelivered
              ? <>Counter saved, but we couldn't DM @{proposerHandle}. Ping them on Discord directly.</>
              : <>Counter sent to <strong>@{proposerHandle}</strong>. They'll see it in a DM.</>}
          </span>
          <a
            href="/?community=1"
            className="px-2.5 py-1 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 text-gray-300 hover:text-gold text-[11px] font-bold transition-colors"
          >
            Back to community
          </a>
        </>
      );
    }

    if (sendState === 'already-resolved') {
      return (
        <span className="flex-1 min-w-0 text-amber-200">
          @{proposerHandle} accepted or changed the original proposal before your counter landed.
          Open their profile to compose a fresh proposal if you still want to trade.
        </span>
      );
    }

    const canSend = offerCount + receiveCount > 0 && sendState !== 'sending';
    return (
      <>
        <span className="flex-1 min-w-0">
          <span className="text-gray-400">Countering </span>
          <strong className="text-gold">@{proposerHandle}</strong>'s proposal
          <span className="text-gray-500 text-[11px] ml-2">
            · Offer <strong className="text-emerald-300">{offerCount}</strong>
            · Receive <strong className="text-blue-300">{receiveCount}</strong>
          </span>
        </span>
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="px-3 py-1.5 rounded-md bg-gold/20 border border-gold/50 text-gold text-[11px] font-bold hover:bg-gold/30 hover:border-gold/70 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {sendState === 'sending' ? 'Sending…' : 'Send counter'}
        </button>
      </>
    );
  })();

  const debugState = (() => {
    if (sendState === 'sent') return 'sent';
    if (sendState === 'sent-undelivered') return 'sent-undelivered';
    if (sendState === 'sending') return 'sending';
    if (sendState === 'already-resolved') return 'already-resolved';
    if (sendState === 'error') return 'send-error';
    if (loadState !== 'ready') return loadState;
    return 'ready';
  })();

  const showMessageInput = loadState === 'ready' && sendState !== 'sent' && sendState !== 'sent-undelivered';

  return (
    <div
      className="shrink-0 px-3 pt-2 pb-3 max-w-5xl mx-auto w-full"
      data-testid="counter-bar"
      data-state={debugState}
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2 rounded-lg bg-gold/10 border border-gold/30 text-xs text-gray-200">
        {body}
      </div>
      {showMessageInput && (
        <div className="mt-1.5 px-1">
          <button
            type="button"
            onClick={() => setMessageOpen(o => !o)}
            className="inline-flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gold transition-colors"
            aria-expanded={messageOpen}
          >
            {messageOpen ? 'Hide note' : message.trim() ? `Note added (${message.trim().length}/500)` : 'Add a note'}
          </button>
          {messageOpen && (
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value.slice(0, 500))}
              disabled={sendState === 'sending'}
              placeholder="Explain the counter — why this split works better for you, etc."
              rows={2}
              maxLength={500}
              className="mt-1.5 w-full bg-space-800/60 border border-space-700 rounded-md px-2.5 py-1.5 text-[11px] text-gray-100 placeholder-gray-500 resize-y min-h-[44px] focus:border-gold/50 focus:outline-none disabled:opacity-50"
              aria-label="Counter note (optional)"
            />
          )}
        </div>
      )}
      {sendState === 'error' && sendError && (
        <div className="mt-1 text-[11px] text-red-300 px-1">
          Couldn't send: {sendError}
        </div>
      )}
    </div>
  );
}
