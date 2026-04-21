import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Sparkles } from 'lucide-react';
import type { TradeCard } from '../types';
import { computeMatch, type MatchMode, type MatchResult } from '../utils/matchmaker';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import type { RecipientProfile, FetchState } from '../hooks/useRecipientProfile';
import { useCardIndexContext } from '../contexts/CardIndexContext';
import { usePricing } from '../contexts/PricingContext';
import { useComposerBar, type SnapshotCard } from '../hooks/useComposerBar';
import { usePrimaryAction } from '../hooks/usePrimaryAction';
import type { PrimaryActionSpec } from '../contexts/PrimaryActionContext';

interface ProposeBarProps {
  recipientHandle: string;
  wants: WantsApi;
  available: AvailableApi;
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  /** Recipient's public lists fetched at the App level so TradeSide's
   *  source-chip pools stay in sync with the matchmaker's view of
   *  them. Parent owns the fetch via useRecipientProfile. */
  recipientProfile: RecipientProfile | null;
  recipientFetchState: FetchState;
  onApplyMatch: (yours: TradeCard[], theirs: TradeCard[]) => void;
}

/**
 * Sticky bottom bar shown while composing a proposal at
 * `/?propose=<handle>`. Companion to AutoBalanceBanner, but
 * distinct enough in lifecycle + copy that sharing the component
 * would mean uglier branching than two focused siblings:
 *
 *   - Auto-applies the matchmaker result on mount (once) using
 *     the recipient's public lists. Stays visible after that —
 *     it's the commit affordance, not a dismissible prompt.
 *   - Persists across trade edits so the user can adjust before
 *     clicking Send.
 *   - Send → opens a review modal (summary + note) →
 *     POST /api/trades/propose → confirmation state.
 *
 * The review modal exists because beta feedback flagged the prior
 * "Add a note" disclosure as too small and easy to miss. Folding
 * the note into a dedicated confirmation step gives both the note
 * and the final review a proper home — and users get a beat to
 * double-check before committing.
 *
 * Trade-card snapshots are built by `useComposerBar.buildSnapshot`
 * (matching the helper in TradeSummary) so the DB row captures exact
 * price / variant labels at proposal time, not whatever the client
 * might compute later. See `trade_proposals` schema comment for why
 * the snapshot matters.
 */
export function ProposeBar({
  recipientHandle,
  wants,
  available,
  yourCards,
  theirCards,
  recipientProfile: profile,
  recipientFetchState: fetchState,
  onApplyMatch,
}: ProposeBarProps) {
  const { allLoadedCards: allCards } = useCardIndexContext();
  const { percentage, priceMode } = usePricing();
  const [sentTradeId, setSentTradeId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const composer = useComposerBar({ yourCards, theirCards });
  const { message, setMessage, sendState, submit, buildSnapshot, resetSendState } = composer;

  // Build a preview for the given mode. Both modes share the same
  // overlap pool computation inside computeMatch — only the subset-
  // selection step differs — so the memo deps are identical. We
  // compute both eagerly so the two Suggest buttons can light up or
  // hide instantly without re-running on click.
  const buildPreview = useCallback((mode: MatchMode): MatchResult | null => {
    if (!profile) return null;
    if (allCards.length === 0) return null;
    return computeMatch(
      wants.items.map(w => ({
        familyId: w.familyId,
        qty: w.qty,
        restriction: w.restriction,
        isPriority: w.isPriority,
      })),
      available.items.map(a => ({ productId: a.productId, qty: a.qty })),
      profile.wants ?? [],
      profile.available ?? [],
      allCards,
      priceMode,
      percentage,
      mode,
    );
  }, [profile, allCards, percentage, priceMode, wants.items, available.items]);

  // `preview` (minimize-imbalance) drives the Suggest button + the
  // overlap-count hint in the status line. `priorityPreview` is the
  // alt-mode result; we compare it with `preview` to decide whether
  // the priorities button would produce something different enough
  // to warrant surfacing.
  const preview = useMemo<MatchResult | null>(
    () => buildPreview('minimize-imbalance'),
    [buildPreview],
  );
  const priorityPreview = useMemo<MatchResult | null>(
    () => buildPreview('maximize-priorities'),
    [buildPreview],
  );

  // Manual Suggest — user-triggered instead of auto-applied on mount.
  // Auto-fill felt presumptuous and the old greedy algorithm produced
  // visibly unbalanced trades; the new subset-sum + modes approach
  // pairs with this explicit opt-in so users always see the choice
  // between "minimize imbalance" and "maximize priorities".
  const handleSuggest = useCallback((mode: MatchMode) => {
    const result = mode === 'minimize-imbalance' ? preview : priorityPreview;
    if (!result) return;
    if (result.offering.length === 0 && result.receiving.length === 0) return;
    onApplyMatch(
      result.offering.map(c => ({ card: c, qty: 1 })),
      result.receiving.map(c => ({ card: c, qty: 1 })),
    );
  }, [preview, priorityPreview, onApplyMatch]);

  // Only surface the priorities button when it would actually produce
  // a different trade than minimize-imbalance. Same-result case =
  // no priority stars in the overlap, which makes the second button
  // noise rather than a meaningful choice.
  const showPrioritiesSuggest = !!preview && !!priorityPreview && (
    !productIdsEqual(preview.offering, priorityPreview.offering)
    || !productIdsEqual(preview.receiving, priorityPreview.receiving)
  );

  // Snapshots for the confirm modal preview + the POST payload share
  // the hook's `buildSnapshot` so the preview can't drift from what
  // the server actually receives.
  const offeringSnapshot = useMemo(() => buildSnapshot(yourCards), [buildSnapshot, yourCards]);
  const receivingSnapshot = useMemo(() => buildSnapshot(theirCards), [buildSnapshot, theirCards]);

  const handleSend = useCallback(async () => {
    await submit({
      endpoint: '/api/trades/propose',
      body: { recipientHandle },
      onSuccess: data => {
        if (data.id) setSentTradeId(data.id);
        // Close the confirm modal — the post-send banner lives in the
        // main bar, not the modal.
        setConfirmOpen(false);
      },
    });
  }, [submit, recipientHandle]);

  // Cancelling a draft proposal returns the user to the place they
  // arrived from (community directory or the counterpart's profile).
  // Same-origin referrer → history.back(); otherwise default to the
  // community directory, which is the canonical landing when there's
  // no specific prior page to return to. Carries an `are you sure?`
  // guard when the user already has cards picked — a Suggest click
  // plus some manual edits represents non-trivial work to discard.
  const handleCancel = useCallback(() => {
    const hasWork = yourCards.length > 0 || theirCards.length > 0 || message.trim().length > 0;
    if (hasWork && !window.confirm('Discard this draft proposal?')) return;
    try {
      const ref = document.referrer;
      if (ref && new URL(ref).origin === window.location.origin) {
        window.history.back();
        return;
      }
    } catch {
      // fall through
    }
    window.location.href = '/?community=1';
  }, [yourCards.length, theirCards.length, message]);

  const sending = sendState.kind === 'sending';
  const sent = sendState.kind === 'sent';
  const undelivered = sent && sendState.deliveryStatus === 'failed';
  const sendError = sendState.kind === 'error' ? sendState.message : null;

  // Pull counts up out of the body-IIFE so the primary action hook
  // (below) can register its disabled state without re-computing them.
  // Consumed by `body` too via closure.
  const offerCount = yourCards.reduce((n, c) => n + c.qty, 0);
  const receiveCount = theirCards.reduce((n, c) => n + c.qty, 0);
  const canSend = offerCount + receiveCount > 0 && !sending;

  // Opening the confirm modal is the "primary action" on this bar —
  // the modal hosts the real Send. Resetting the error state here means
  // a previous failure doesn't keep the bar stuck in 'error' after the
  // user retries.
  const openConfirm = useCallback(() => {
    if (!canSend) return;
    if (sendState.kind === 'error') resetSendState();
    setConfirmOpen(true);
  }, [canSend, sendState.kind, resetSendState]);

  // Register the Send proposal CTA with the shared bottom bar. Hidden
  // during upstream fetch states (`!profile`, `fetchState === 'error'`,
  // recipient-private) and after-send so the user reads the banner
  // once and isn't tempted to re-send.
  const primaryAction = useMemo<PrimaryActionSpec | null>(() => {
    if (!profile || fetchState === 'error') return null;
    if (sent) {
      return {
        label: undelivered ? 'Proposal saved' : 'Proposal sent',
        onClick: () => {},
        sent: true,
        testId: 'propose-primary-action',
      };
    }
    return {
      label: 'Send proposal',
      loadingLabel: 'Sending…',
      onClick: openConfirm,
      disabled: !canSend,
      loading: sending,
      error: sendError ?? undefined,
      hint: !canSend && !sending ? 'Add at least one card to either side to enable.' : undefined,
      testId: 'propose-open-confirm',
    };
  }, [profile, fetchState, sent, undelivered, canSend, sending, sendError, openConfirm]);
  usePrimaryAction(primaryAction);

  const body = (() => {
    if (sent && !undelivered) {
      return (
        <>
          <span className="flex-1 min-w-0 text-emerald-300">
            Proposal sent to <strong>@{recipientHandle}</strong>. They'll see it in a Discord DM.
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href="/?trades=1"
              className="px-2.5 py-1 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 text-gray-300 hover:text-gold text-[11px] font-bold transition-colors"
            >
              View your trades
            </a>
          </div>
        </>
      );
    }

    if (undelivered) {
      return (
        <>
          <span className="flex-1 min-w-0 text-amber-200">
            Proposal saved, but Discord wouldn't let us DM <strong>@{recipientHandle}</strong> —
            they may have DMs from the bot disabled. Send them a message on Discord so they know to check.
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href="/?trades=1"
              className="px-2.5 py-1 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 text-gray-300 hover:text-gold text-[11px] font-bold transition-colors"
            >
              View your trades
            </a>
          </div>
        </>
      );
    }

    if (fetchState === 'error') {
      return (
        <span className="flex-1 min-w-0 text-red-300">
          Couldn't reach @{recipientHandle}'s profile — they may have made it private.
        </span>
      );
    }

    if (!profile) {
      return (
        <span className="flex-1 min-w-0 text-gray-400 animate-pulse">
          Loading @{recipientHandle}'s lists…
        </span>
      );
    }

    // offerCount / receiveCount / canSend are computed outside the
    // IIFE so the primary action hook can use them; consumed here by
    // closure.
    const overlapAvailable = !!preview
      && (preview.overlapOffering > 0 || preview.overlapReceiving > 0);
    const isEmpty = offerCount + receiveCount === 0;

    // Status line has two modes: empty (hint at overlap possibilities)
    // and in-progress (running card counts). Splitting keeps the first-
    // open state informative without cluttering the working state.
    // Phrasing preferred for the empty state: "N cards you have match
    // their wants · M of theirs match yours" — more explicit than
    // "of their wants / of yours", which read as "they want 4 specific
    // things" when it's really "4 family-level overlaps."
    const status = isEmpty && preview ? (
      <span className="flex-1 min-w-0">
        <span className="text-gray-400">Proposing to </span>
        <strong className="text-gold">@{recipientHandle}</strong>
        {overlapAvailable ? (
          <span className="text-gray-500 text-[11px] ml-2">
            · <strong className="text-emerald-300">{preview.overlapOffering}</strong> cards you have match their wants
            · <strong className="text-blue-300">{preview.overlapReceiving}</strong> of theirs match yours
          </span>
        ) : (
          <span className="text-gray-500 text-[11px] ml-2">
            · No matching overlap — pick cards manually to propose anyway.
          </span>
        )}
      </span>
    ) : (
      <span className="flex-1 min-w-0">
        <span className="text-gray-400">Proposing to </span>
        <strong className="text-gold">@{recipientHandle}</strong>
        <span className="text-gray-500 text-[11px] ml-2">
          · Offer <strong className="text-emerald-300">{offerCount}</strong>
          · Receive <strong className="text-blue-300">{receiveCount}</strong>
        </span>
      </span>
    );

    return (
      <>
        {/* Cancel + status ride together on the first row (mobile)
            so the back-arrow stays anchored to the info text rather
            than drifting above an empty action cluster. */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Cancel / back affordance. First-beta users reported
              feeling stuck in the propose flow with no obvious exit
              — browser back worked but wasn't visible. */}
          <button
            type="button"
            onClick={handleCancel}
            title="Cancel and return to community"
            className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md text-gray-500 hover:text-gray-200 hover:bg-space-700/60 transition-colors"
            aria-label="Cancel proposal"
          >
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M10 4L6 8l4 4" />
            </svg>
          </button>
          {status}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {overlapAvailable && (
            <button
              type="button"
              onClick={() => handleSuggest('minimize-imbalance')}
              data-testid="propose-suggest"
              title="Tightest card-for-card match; any remainder is implied cash."
              className="inline-flex items-center px-2.5 py-1.5 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 text-gray-300 hover:text-gold text-[11px] font-semibold transition-colors"
            >
              <Sparkles aria-hidden className="w-4 h-4 mr-1" />
              Suggest a match
            </button>
          )}
          {showPrioritiesSuggest && (
            <button
              type="button"
              onClick={() => handleSuggest('maximize-priorities')}
              data-testid="propose-suggest-priorities"
              title="Include every priority-starred card, even if it widens the imbalance."
              className="px-2.5 py-1.5 rounded-md bg-space-800/60 border border-space-700 hover:border-gold-bright/40 text-gray-300 hover:text-gold-bright text-[11px] font-semibold transition-colors"
            >
              ★ Priorities
            </button>
          )}
          {/* Send proposal primary action moved to the shared
              PrimaryActionBar at the bottom of the builder. The bar's
              onClick opens the confirm modal — same flow as the old
              inline button — just rendered in a thumb-reachable spot
              with consistent gold styling across composer modes. */}
        </div>
      </>
    );
  })();

  // Preserve the prior `data-state` contract. `sent-undelivered` is
  // derived from the (collapsed) `sent` + deliveryStatus so debug
  // selectors keep working.
  const debugState = sent
    ? (undelivered ? 'sent-undelivered' : 'sent')
    : sending
      ? 'sending'
      : fetchState === 'error'
        ? 'fetch-error'
        : !profile
          ? 'loading-profile'
          : sendState.kind === 'error'
            ? 'send-error'
            : 'ready';

  return (
    <div
      className="shrink-0 px-3 pt-2 pb-3 max-w-5xl mx-auto w-full"
      data-testid="propose-bar"
      data-state={debugState}
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2 rounded-lg bg-gold/10 border border-gold/30 text-xs text-gray-200">
        {body}
      </div>
      {/* Send error renders under the PrimaryActionBar (bottom of
          screen) now — kept near the retry target rather than split
          across top and bottom of the page. */}
      {sentTradeId && (
        <div className="mt-1 text-[10px] text-gray-500 px-1 font-mono truncate">
          Trade {sentTradeId}
        </div>
      )}

      <ConfirmProposalDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        recipientHandle={recipientHandle}
        offering={offeringSnapshot}
        receiving={receivingSnapshot}
        message={message}
        onChangeMessage={setMessage}
        sending={sending}
        errorMessage={sendError}
        onSend={handleSend}
      />
    </div>
  );
}

/** Order-independent productId comparison — two match results are
 *  the same picked set when their cards match regardless of order. */
function productIdsEqual(a: { productId?: string }[], b: { productId?: string }[]): boolean {
  if (a.length !== b.length) return false;
  const ids = (xs: { productId?: string }[]) =>
    xs.map(c => c.productId ?? '').filter(Boolean).sort().join(',');
  return ids(a) === ids(b);
}

const MESSAGE_MAX_LENGTH = 500;

interface ConfirmProposalDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  recipientHandle: string;
  offering: SnapshotCard[];
  receiving: SnapshotCard[];
  message: string;
  onChangeMessage: (next: string) => void;
  sending: boolean;
  errorMessage: string | null;
  onSend: () => void;
}

/**
 * Confirm/summary modal rendered by ProposeBar on Send. Review step
 * lives here rather than on the main bar because the note input is
 * important context that deserves room to breathe, and because users
 * asked for a beat to re-read the trade before committing. Styling
 * mirrors ListsDrawer's Radix Dialog (bottom-sheet on mobile,
 * centered card on desktop) so the two feel like the same app.
 */
function ConfirmProposalDialog({
  open,
  onOpenChange,
  recipientHandle,
  offering,
  receiving,
  message,
  onChangeMessage,
  sending,
  errorMessage,
  onSend,
}: ConfirmProposalDialogProps) {
  // Lock the modal closed while a send is in flight — preserves the
  // user's "I clicked send" mental model even if they try to Escape
  // or click the backdrop mid-request.
  const handleOpenChange = useCallback((next: boolean) => {
    if (sending) return;
    onOpenChange(next);
  }, [sending, onOpenChange]);

  // When the modal opens with no draft note, park focus on the
  // textarea so keyboard users can start typing immediately. Radix
  // auto-focuses the first focusable descendant (the Close button);
  // overriding here lines up with the "note is the reason for this
  // modal" framing.
  const [textareaEl, setTextareaEl] = useState<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!open) return;
    if (!textareaEl) return;
    const id = window.setTimeout(() => textareaEl.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(id);
  }, [open, textareaEl]);

  const offeringTotal = offering.reduce((n, c) => n + (c.unitPrice ?? 0) * c.qty, 0);
  const receivingTotal = receiving.reduce((n, c) => n + (c.unitPrice ?? 0) * c.qty, 0);
  const diff = offeringTotal - receivingTotal;
  const remainingChars = MESSAGE_MAX_LENGTH - message.length;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="propose-confirm"
          onOpenAutoFocus={e => {
            // Skip Radix's default first-focusable behavior so our
            // textarea effect can grab focus cleanly.
            e.preventDefault();
          }}
          className={[
            'drawer-content z-50 bg-space-900 border border-space-700 text-gray-100 shadow-2xl',
            'flex flex-col',
            // Mobile: bottom sheet. Matches ListsDrawer conventions.
            'max-h-[90dvh] rounded-t-2xl border-b-0',
            // Desktop: centered modal.
            'md:w-[min(640px,calc(100vw-2rem))] md:max-h-[85dvh] md:rounded-2xl md:border md:border-b',
          ].join(' ')}
        >
          {/* Drag-handle affordance (mobile only). */}
          <div className="flex justify-center pt-2 md:hidden">
            <span className="w-10 h-1 rounded-full bg-space-700" aria-hidden />
          </div>

          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-space-800">
            <Dialog.Title className="text-sm font-bold tracking-[0.08em] text-gold">
              Send to <span className="text-gold">@{recipientHandle}</span>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                disabled={sending}
                className="text-gray-500 hover:text-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <CloseIcon className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-4">
            {/* Summary: two-column on desktop, stacked on mobile. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <ConfirmCardGroup label="You're offering" tone="emerald" cards={offering} />
              <ConfirmCardGroup label="You'll receive" tone="blue" cards={receiving} />
            </div>

            {/* Totals / imbalance strip. Tone mirrors TradeDetailView's
                ImbalanceStrip: amber when non-zero, muted when balanced
                enough that the number is noise. */}
            <TotalsStrip offeringTotal={offeringTotal} receivingTotal={receivingTotal} diff={diff} />

            {/* Optional note — the headline reason this modal exists. */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="propose-confirm-note"
                className="text-[11px] font-bold tracking-[0.1em] uppercase text-gray-400"
              >
                Add a note (optional)
              </label>
              <textarea
                id="propose-confirm-note"
                ref={setTextareaEl}
                value={message}
                onChange={e => onChangeMessage(e.target.value)}
                disabled={sending}
                placeholder="Optional context for the recipient — a deck they're building for, a meetup time, etc."
                rows={5}
                maxLength={MESSAGE_MAX_LENGTH}
                className="w-full bg-space-800/60 border border-space-700 rounded-md px-3 py-2 text-xs text-gray-100 placeholder-gray-500 resize-y min-h-[100px] focus:border-gold/50 focus:outline-none disabled:opacity-50"
                aria-label="Proposal note"
              />
              <div className="flex justify-end text-[10px] text-gray-500 tabular-nums">
                {remainingChars} character{remainingChars === 1 ? '' : 's'} left
              </div>
            </div>

            {errorMessage && (
              <div
                role="alert"
                className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300"
              >
                Couldn't send: {errorMessage}
              </div>
            )}
          </div>

          <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-3 border-t border-space-800">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={sending}
                className="px-3 py-1.5 rounded-md bg-space-800/60 border border-space-700 text-gray-300 text-[11px] font-bold hover:border-gold/40 hover:text-gold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={onSend}
              disabled={sending || (offering.length === 0 && receiving.length === 0)}
              data-testid="confirm-send"
              className="px-3 py-1.5 rounded-md bg-gold/20 border border-gold/50 text-gold text-[11px] font-bold hover:bg-gold/30 hover:border-gold/70 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending…' : 'Send proposal'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Compact card summary used only inside the confirm modal. Purposely
 * local to this file — TradeDetailView's CardGroup works against a
 * different snapshot shape (CardSnapshot from useTradeDetail) and
 * lives in a full-page context; trying to share would mean either
 * prop-drilling styling or bending one call site to fit the other.
 */
function ConfirmCardGroup({
  label,
  tone,
  cards,
}: {
  label: string;
  tone: 'emerald' | 'blue';
  cards: SnapshotCard[];
}) {
  const accent = tone === 'emerald' ? 'text-emerald-300' : 'text-blue-300';
  const border = tone === 'emerald' ? 'border-emerald-500/30' : 'border-blue-500/30';
  const total = cards.reduce((n, c) => n + (c.unitPrice ?? 0) * c.qty, 0);

  return (
    <section>
      <div className="flex items-baseline justify-between mb-1.5">
        <h3 className={`text-[10px] tracking-[0.18em] uppercase font-bold ${accent}`}>{label}</h3>
        {total > 0 && (
          <span className="text-[11px] text-gray-400 tabular-nums">${total.toFixed(2)}</span>
        )}
      </div>
      {cards.length === 0 ? (
        <div className="rounded-lg border border-space-700 bg-space-800/40 px-3 py-2 text-[11px] text-gray-500 italic">
          None
        </div>
      ) : (
        <ul className={`flex flex-col rounded-lg border ${border} bg-space-800/40 divide-y divide-space-800 overflow-hidden`}>
          {cards.map((c, i) => (
            <li key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
              <span className="text-gray-500 tabular-nums shrink-0 w-6">{c.qty}×</span>
              <span className="flex-1 min-w-0 truncate text-gray-100">{c.name}</span>
              <span
                className="text-[9px] text-gray-500 tracking-wider uppercase shrink-0 px-1.5 py-px rounded bg-space-900/60 border border-space-700"
                aria-label={`Variant: ${c.variant}`}
              >
                {c.variant}
              </span>
              {c.unitPrice !== null && c.unitPrice > 0 && (
                <span className="text-[10px] text-gray-400 tabular-nums shrink-0 w-14 text-right">
                  ${(c.unitPrice * c.qty).toFixed(2)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Totals row. Mirrors ImbalanceStrip's tone choices (amber when the
 * sides diverge, subdued otherwise) so a user coming from
 * TradeDetailView feels at home. The numbers are always shown — even
 * when balanced — so the user can sanity-check both sides' value,
 * not just the delta.
 */
function TotalsStrip({
  offeringTotal,
  receivingTotal,
  diff,
}: {
  offeringTotal: number;
  receivingTotal: number;
  diff: number;
}) {
  const balanced = Math.abs(diff) < 0.5;
  const container = balanced
    ? 'border-space-700 bg-space-800/40 text-gray-300'
    : 'border-amber-500/30 bg-amber-500/5 text-amber-200';
  return (
    <section
      className={`rounded-lg border px-3 py-2 text-[11px] flex flex-wrap items-center gap-x-4 gap-y-1 ${container}`}
    >
      <span>
        <span className="text-gray-500">Offering </span>
        <strong className="text-emerald-300 tabular-nums">${offeringTotal.toFixed(2)}</strong>
      </span>
      <span className="text-gray-600">·</span>
      <span>
        <span className="text-gray-500">Receiving </span>
        <strong className="text-blue-300 tabular-nums">${receivingTotal.toFixed(2)}</strong>
      </span>
      <span className="text-gray-600">·</span>
      <span className="font-semibold">
        {balanced ? (
          <>Balanced</>
        ) : (
          <>
            <span className="tabular-nums">${Math.abs(diff).toFixed(2)}</span>{' '}
            imbalance{' '}
            <span className="text-gray-500 font-normal">
              (implied cash from {diff > 0 ? 'them' : 'you'})
            </span>
          </>
        )}
      </span>
    </section>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 4L12 12M4 12L12 4" />
    </svg>
  );
}
