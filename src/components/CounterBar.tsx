import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TradeCard } from '../types';
import { useCardIndexContext } from '../contexts/CardIndexContext';
import { useComposerBar } from '../hooks/useComposerBar';
import { usePrimaryAction } from '../hooks/usePrimaryAction';
import type { PrimaryActionSpec } from '../contexts/PrimaryActionContext';

interface CardSnapshot {
  productId: string;
  name: string;
  variant: string;
  qty: number;
  unitPrice: number | null;
}

interface CounterBarProps {
  originalTradeId: string;
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
 *
 * Shared send/snapshot/message state lives in `useComposerBar`; the
 * per-bar mount fetch + seed-once pattern stays inline here because
 * the fetch shape differs between the three composers.
 */
export function CounterBar({
  originalTradeId,
  yourCards,
  theirCards,
  onApplyMatch,
}: CounterBarProps) {
  const { byProductId } = useCardIndexContext();
  const [original, setOriginal] = useState<OriginalTradeResponse | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'forbidden' | 'not-found' | 'error' | 'not-recipient' | 'not-pending'>('loading');
  const autoAppliedRef = useRef(false);
  const fetchStartedRef = useRef(false);

  const composer = useComposerBar({ yourCards, theirCards });
  const {
    message,
    setMessage,
    messageOpen,
    toggleMessage,
    sendState,
    submit,
  } = composer;

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

  const handleSend = useCallback(() => {
    submit({
      endpoint: '/api/trades/counter',
      body: { counterOfId: originalTradeId },
    });
  }, [submit, originalTradeId]);

  const proposerHandle = original?.proposer?.handle ?? null;
  const offerCount = yourCards.reduce((n, c) => n + c.qty, 0);
  const receiveCount = theirCards.reduce((n, c) => n + c.qty, 0);

  const sending = sendState.kind === 'sending';
  const sent = sendState.kind === 'sent';
  const undelivered = sent && sendState.deliveryStatus === 'failed';
  const alreadyResolved = sendState.kind === 'already-resolved';
  const sendError = sendState.kind === 'error' ? sendState.message : null;

  // Register the primary action (Send counter) with the shared bottom
  // bar. Memoized for context shallow-compare; see usePrimaryAction
  // JSDoc. Spec is null for load states + terminal states where no
  // retry is meaningful.
  const canSend = offerCount + receiveCount > 0 && !sending;
  const primaryAction = useMemo<PrimaryActionSpec | null>(() => {
    if (loadState !== 'ready') return null;
    if (sent) {
      return {
        label: undelivered ? 'Counter saved' : 'Counter sent',
        onClick: () => {},
        sent: true,
        testId: 'counter-primary-action',
      };
    }
    if (alreadyResolved) return null;
    return {
      label: 'Send counter',
      loadingLabel: 'Sending…',
      onClick: handleSend,
      disabled: !canSend,
      loading: sending,
      error: sendError ?? undefined,
      testId: 'counter-primary-action',
    };
  }, [loadState, sent, undelivered, alreadyResolved, canSend, sending, sendError, handleSend]);
  usePrimaryAction(primaryAction);

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

    if (sent) {
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

    if (alreadyResolved) {
      return (
        <span className="flex-1 min-w-0 text-amber-200">
          @{proposerHandle} accepted or changed the original proposal before your counter landed.
          Open their profile to compose a fresh proposal if you still want to trade.
        </span>
      );
    }

    // Primary action (Send counter) lives in the shared PrimaryActionBar.
    // This banner is informational context only.
    return (
      <span className="flex-1 min-w-0">
        <span className="text-gray-400">Countering </span>
        <strong className="text-gold">@{proposerHandle}</strong>'s proposal
        <span className="text-gray-500 text-[11px] ml-2">
          · Offer <strong className="text-emerald-300">{offerCount}</strong>
          · Receive <strong className="text-blue-300">{receiveCount}</strong>
        </span>
      </span>
    );
  })();

  // Preserve the prior `data-state` attribute values for e2e /
  // debugging continuity. `sent-undelivered` is derived from the
  // (collapsed) `sent` + deliveryStatus so selectors keep working.
  const dataState = (() => {
    if (sent) return undelivered ? 'sent-undelivered' : 'sent';
    if (sending) return 'sending';
    if (alreadyResolved) return 'already-resolved';
    if (sendState.kind === 'error') return 'send-error';
    if (loadState !== 'ready') return loadState;
    return 'ready';
  })();

  const showMessageInput = loadState === 'ready' && !sent;

  return (
    <div
      className="shrink-0 px-3 pt-2 pb-3 max-w-5xl mx-auto w-full"
      data-testid="counter-bar"
      data-state={dataState}
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2 rounded-lg bg-gold/10 border border-gold/30 text-xs text-gray-200">
        {body}
      </div>
      {showMessageInput && (
        <div className="mt-1.5 px-1">
          <button
            type="button"
            onClick={toggleMessage}
            className="inline-flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gold transition-colors"
            aria-expanded={messageOpen}
          >
            {messageOpen ? 'Hide note' : message.trim() ? `Note added (${message.trim().length}/500)` : 'Add a note'}
          </button>
          {messageOpen && (
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              disabled={sending}
              placeholder="Explain the counter — why this split works better for you, etc."
              rows={2}
              maxLength={500}
              className="mt-1.5 w-full bg-space-800/60 border border-space-700 rounded-md px-2.5 py-1.5 text-[11px] text-gray-100 placeholder-gray-500 resize-y min-h-[44px] focus:border-gold/50 focus:outline-none disabled:opacity-50"
              aria-label="Counter note (optional)"
            />
          )}
        </div>
      )}
      {/* Send error renders under the PrimaryActionBar now. */}
    </div>
  );
}
