import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TradeCard } from '../types';
import { useCardIndexContext } from '../contexts/CardIndexContext';
import { useComposerBar } from '../hooks/useComposerBar';
import { usePrimaryAction } from '../hooks/usePrimaryAction';
import type { PrimaryActionSpec } from '../contexts/PrimaryActionContext';
import { LoadingState } from './ui/states';

interface CardSnapshot {
  productId: string;
  name: string;
  variant: string;
  qty: number;
  unitPrice: number | null;
}

interface EditBarProps {
  editingTradeId: string;
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  onApplyMatch: (yours: TradeCard[], theirs: TradeCard[]) => void;
}

interface EditingTradeResponse {
  id: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'countered' | 'promoted';
  offeringCards: CardSnapshot[];
  receivingCards: CardSnapshot[];
  message: string | null;
  proposer: { handle: string; username: string; avatarUrl: string | null } | null;
  recipient: { handle: string; username: string; avatarUrl: string | null } | null;
  viewerIsProposer: boolean;
}

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
 *
 * Shared send/snapshot/message state lives in `useComposerBar`; the
 * per-bar mount fetch + seed-once pattern stays inline here because
 * the fetch shape differs between the three composers.
 */
export function EditBar({
  editingTradeId,
  yourCards,
  theirCards,
  onApplyMatch,
}: EditBarProps) {
  const { byProductId } = useCardIndexContext();
  const [original, setOriginal] = useState<EditingTradeResponse | null>(null);
  const [loadState, setLoadState] = useState<
    'loading' | 'ready' | 'forbidden' | 'not-found' | 'error' | 'not-proposer' | 'not-pending'
  >('loading');
  const [messageDirty, setMessageDirty] = useState(false);
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
  }, [editingTradeId, messageDirty, setMessage]);

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

  const handleSave = useCallback(() => {
    submit({
      endpoint: '/api/trades?action=edit',
      body: { id: editingTradeId },
    });
  }, [submit, editingTradeId]);

  const recipientHandle = original?.recipient?.handle ?? null;
  const offerCount = yourCards.reduce((n, c) => n + c.qty, 0);
  const receiveCount = theirCards.reduce((n, c) => n + c.qty, 0);

  // EditBar doesn't branch on deliveryStatus — re-delivery of an edit
  // is best-effort DM update, not a fresh send. `sent` collapses to
  // "saved" here regardless of the delivery outcome.
  const saved = sendState.kind === 'sent';
  const alreadyResolved = sendState.kind === 'already-resolved';
  const saving = sendState.kind === 'sending';
  const sendError = sendState.kind === 'error' ? sendState.message : null;

  // Register the primary action with the shared bottom bar. Memoized so
  // the context can shallow-compare and skip redundant updates — a new
  // spec object every render would thrash. Spec is null in states that
  // don't have a primary action (load states, saved, already-resolved)
  // so the bar simply hides in those cases.
  const canSave = offerCount + receiveCount > 0 && !saving;
  const primaryAction = useMemo<PrimaryActionSpec | null>(() => {
    if (loadState !== 'ready') return null;
    if (saved) {
      return {
        label: 'Saved',
        onClick: () => {},
        sent: true,
        testId: 'edit-primary-action',
      };
    }
    if (alreadyResolved) return null;
    return {
      label: 'Save edits',
      loadingLabel: 'Saving…',
      onClick: handleSave,
      disabled: !canSave,
      loading: saving,
      error: sendError ?? undefined,
      testId: 'edit-primary-action',
    };
  }, [loadState, saved, alreadyResolved, canSave, saving, sendError, handleSave]);
  usePrimaryAction(primaryAction);

  const body = (() => {
    if (loadState === 'loading') {
      return <LoadingState inline className="flex-1 min-w-0" label="Loading the proposal…" />;
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

    if (saved) {
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

    if (alreadyResolved) {
      return (
        <span className="flex-1 min-w-0 text-amber-200">
          <strong>@{recipientHandle}</strong> responded before your edit landed. Open the proposal to
          see the new state.
        </span>
      );
    }

    // Primary action (Save edits) lives in the shared PrimaryActionBar
    // at the bottom of the trade builder — registered above via
    // `usePrimaryAction`. This informational banner is just context.
    return (
      <span className="flex-1 min-w-0">
        <span className="text-gray-400">Editing your proposal to </span>
        <strong className="text-gold">@{recipientHandle}</strong>
        <span className="text-gray-500 text-[11px] ml-2">
          · Offer <strong className="text-emerald-300">{offerCount}</strong>
          · Receive <strong className="text-blue-300">{receiveCount}</strong>
        </span>
      </span>
    );
  })();

  // Preserve the prior `data-state` contract: loadState wins when the
  // bar isn't ready yet; once ready, the send machine drives it.
  // Values map 1:1 to the previous SaveState names.
  const dataState = (() => {
    if (loadState !== 'ready') return loadState;
    if (sendState.kind === 'sent') return 'saved';
    if (sendState.kind === 'sending') return 'saving';
    if (sendState.kind === 'already-resolved') return 'already-resolved';
    if (sendState.kind === 'error') return 'error';
    return 'idle';
  })();

  const showMessageInput = loadState === 'ready' && !saved;

  return (
    <div
      className="shrink-0 px-3 pt-2 pb-3 max-w-5xl mx-auto w-full"
      data-testid="edit-bar"
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
                setMessage(e.target.value);
                setMessageDirty(true);
              }}
              disabled={saving}
              placeholder="Update the note sent to the recipient — why the revision, timing, etc."
              rows={2}
              maxLength={500}
              className="mt-1.5 w-full bg-space-800/60 border border-space-700 rounded-md px-2.5 py-1.5 text-[11px] text-gray-100 placeholder-gray-500 resize-y min-h-[44px] focus:border-gold/50 focus:outline-none disabled:opacity-50"
              aria-label="Proposal note"
            />
          )}
        </div>
      )}
      {/* Send error renders under the PrimaryActionBar now — one place
          for the user to see "something went wrong" near the retry
          target. See `PrimaryActionBar.tsx`. */}
    </div>
  );
}
