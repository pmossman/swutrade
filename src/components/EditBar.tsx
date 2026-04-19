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

interface EditBarProps {
  editingTradeId: string;
  byProductId: Map<string, CardVariant>;
  percentage: number;
  priceMode: PriceMode;
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  onApplyMatch: (yours: TradeCard[], theirs: TradeCard[]) => void;
}

interface EditingTradeResponse {
  id: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'countered';
  offeringCards: CardSnapshot[];
  receivingCards: CardSnapshot[];
  message: string | null;
  proposer: { handle: string; username: string; avatarUrl: string | null } | null;
  recipient: { handle: string; username: string; avatarUrl: string | null } | null;
  viewerIsProposer: boolean;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'already-resolved' | 'error';

/**
 * Sticky bar for `/?edit=<id>` — proposer revises a still-pending
 * proposal in place. Sibling of ProposeBar/CounterBar:
 *
 *   - Loads the existing proposal via GET /api/trades/:id.
 *   - Seeds the trade panels with the CURRENT offering/receiving
 *     (NOT swapped — this is the proposer editing their own proposal).
 *   - Save → POST /api/trades?action=edit with the new arrays + message.
 *   - The server re-delivers the Discord DM/thread message with the
 *     updated payload so the recipient sees the edit in place; the
 *     Accept/Counter/Decline buttons stay intact.
 *
 * Non-proposer / non-pending cases render a clear banner — no fallback
 * to an empty composer.
 */
export function EditBar({
  editingTradeId,
  byProductId,
  percentage,
  priceMode,
  yourCards,
  theirCards,
  onApplyMatch,
}: EditBarProps) {
  const [original, setOriginal] = useState<EditingTradeResponse | null>(null);
  const [loadState, setLoadState] = useState<
    'loading' | 'ready' | 'forbidden' | 'not-found' | 'error' | 'not-proposer' | 'not-pending'
  >('loading');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [messageOpen, setMessageOpen] = useState(false);
  const [messageDirty, setMessageDirty] = useState(false);
  const autoAppliedRef = useRef(false);
  const fetchStartedRef = useRef(false);

  // One-shot fetch.
  useEffect(() => {
    if (!editingTradeId || fetchStartedRef.current) return;
    fetchStartedRef.current = true;

    let cancelled = false;
    setLoadState('loading');
    (async () => {
      try {
        const res = await fetch(`/api/trades/${encodeURIComponent(editingTradeId)}`);
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
        const data: EditingTradeResponse = await res.json();
        if (cancelled) return;
        if (!data.viewerIsProposer) {
          setLoadState('not-proposer');
          return;
        }
        if (data.status !== 'pending') {
          setLoadState('not-pending');
          setOriginal(data);
          return;
        }
        setOriginal(data);
        // Only seed the message input if the user hasn't started
        // editing it already — avoids clobbering their in-progress edit
        // if the fetch somehow re-resolves.
        if (!messageDirty) setMessage(data.message ?? '');
        setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [editingTradeId, messageDirty]);

  // Seed the trade panels once we have the original AND the card
  // index is populated. No side-swap: the proposer keeps their own
  // offering/receiving orientation. One-shot — user edits aren't
  // re-overridden.
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
      yours: toTradeCards(original.offeringCards),
      theirs: toTradeCards(original.receivingCards),
    };
  }, [original, byProductId]);

  useEffect(() => {
    if (autoAppliedRef.current) return;
    if (!seeded) return;
    if (seeded.yours.length === 0 && seeded.theirs.length === 0) return;
    autoAppliedRef.current = true;
    onApplyMatch(seeded.yours, seeded.theirs);
  }, [seeded, onApplyMatch]);

  const handleSave = useCallback(async () => {
    if (saveState === 'saving' || saveState === 'saved') return;
    if (yourCards.length === 0 && theirCards.length === 0) return;

    setSaveState('saving');
    setSaveError(null);

    const snapshot = (cards: TradeCard[]) =>
      cards.map(tc => ({
        productId: tc.card.productId ?? '',
        name: tc.card.name.replace(/\s*\([^)]+\)\s*$/, ''),
        variant: extractVariantLabel(tc.card.name) || tc.card.variant || 'Standard',
        qty: tc.qty,
        unitPrice: adjustPrice(getCardPrice(tc.card, priceMode), percentage),
      }));

    try {
      const res = await fetch('/api/trades?action=edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: editingTradeId,
          offeringCards: snapshot(yourCards),
          receivingCards: snapshot(theirCards),
          message: message.trim() || undefined,
        }),
      });
      if (res.status === 409) {
        setSaveState('already-resolved');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setSaveState('saved');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
      setSaveState('error');
    }
  }, [saveState, yourCards, theirCards, editingTradeId, percentage, priceMode, message]);

  const recipientHandle = original?.recipient?.handle ?? null;
  const offerCount = yourCards.reduce((n, c) => n + c.qty, 0);
  const receiveCount = theirCards.reduce((n, c) => n + c.qty, 0);

  const body = (() => {
    if (loadState === 'loading') {
      return <span className="flex-1 min-w-0 text-gray-400 animate-pulse">Loading the proposal…</span>;
    }
    if (loadState === 'not-found' || loadState === 'forbidden') {
      return (
        <span className="flex-1 min-w-0 text-red-300">
          Couldn't load this proposal — it may have been cancelled, resolved, or sent by someone else.
        </span>
      );
    }
    if (loadState === 'not-proposer') {
      return (
        <span className="flex-1 min-w-0 text-red-300">
          Only the proposer can edit a proposal. You'll want Counter instead.
        </span>
      );
    }
    if (loadState === 'not-pending' && original) {
      return (
        <span className="flex-1 min-w-0 text-amber-200">
          This proposal is already <strong>{original.status}</strong> — editing is only available while it's pending.
        </span>
      );
    }
    if (loadState === 'error') {
      return <span className="flex-1 min-w-0 text-red-300">Couldn't load the proposal. Try refreshing.</span>;
    }

    if (saveState === 'saved') {
      return (
        <>
          <span className="flex-1 min-w-0 text-emerald-300">
            Saved. <strong>@{recipientHandle}</strong>'s Discord message has been updated.
          </span>
          <a
            href={`/?trade=${encodeURIComponent(editingTradeId)}`}
            className="px-2.5 py-1 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 text-gray-300 hover:text-gold text-[11px] font-bold transition-colors"
          >
            View proposal
          </a>
        </>
      );
    }

    if (saveState === 'already-resolved') {
      return (
        <span className="flex-1 min-w-0 text-amber-200">
          <strong>@{recipientHandle}</strong> responded before your edit landed. Open the proposal to
          see the new state.
        </span>
      );
    }

    const canSave = offerCount + receiveCount > 0 && saveState !== 'saving';
    return (
      <>
        <span className="flex-1 min-w-0">
          <span className="text-gray-400">Editing your proposal to </span>
          <strong className="text-gold">@{recipientHandle}</strong>
          <span className="text-gray-500 text-[11px] ml-2">
            · Offer <strong className="text-emerald-300">{offerCount}</strong>
            · Receive <strong className="text-blue-300">{receiveCount}</strong>
          </span>
        </span>
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className="px-3 py-1.5 rounded-md bg-gold/20 border border-gold/50 text-gold text-[11px] font-bold hover:bg-gold/30 hover:border-gold/70 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saveState === 'saving' ? 'Saving…' : 'Save edits'}
        </button>
      </>
    );
  })();

  const showMessageInput = loadState === 'ready' && saveState !== 'saved';

  return (
    <div
      className="shrink-0 px-3 pt-2 pb-3 max-w-5xl mx-auto w-full"
      data-testid="edit-bar"
      data-state={loadState === 'ready' ? saveState : loadState}
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
            {messageOpen
              ? 'Hide note'
              : message.trim()
                ? `Note (${message.trim().length}/500)`
                : 'Add or edit note'}
          </button>
          {messageOpen && (
            <textarea
              value={message}
              onChange={e => {
                setMessage(e.target.value.slice(0, 500));
                setMessageDirty(true);
              }}
              disabled={saveState === 'saving'}
              placeholder="Update the note sent to the recipient — why the revision, timing, etc."
              rows={2}
              maxLength={500}
              className="mt-1.5 w-full bg-space-800/60 border border-space-700 rounded-md px-2.5 py-1.5 text-[11px] text-gray-100 placeholder-gray-500 resize-y min-h-[44px] focus:border-gold/50 focus:outline-none disabled:opacity-50"
              aria-label="Proposal note"
            />
          )}
        </div>
      )}
      {saveState === 'error' && saveError && (
        <div className="mt-1 text-[11px] text-red-300 px-1">
          Couldn't save: {saveError}
        </div>
      )}
    </div>
  );
}
