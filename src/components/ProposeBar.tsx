import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardVariant, PriceMode, TradeCard } from '../types';
import type { VariantRestriction } from '../persistence';
import { computeMatch, type MatchResult } from '../utils/matchmaker';
import {
  adjustPrice,
  getCardPrice,
} from '../services/priceService';
import { extractVariantLabel } from '../variants';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';

interface ProposeBarProps {
  recipientHandle: string;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
  wants: WantsApi;
  available: AvailableApi;
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  onApplyMatch: (yours: TradeCard[], theirs: TradeCard[]) => void;
}

interface RemoteProfile {
  user: { username: string; handle: string; avatarUrl: string | null };
  wants: Array<{ familyId: string; qty: number; restriction: VariantRestriction; isPriority?: boolean }> | null;
  available: Array<{ productId: string; qty: number }> | null;
}

type SendState = 'idle' | 'sending' | 'sent' | 'sent-undelivered' | 'error';

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
 *   - Send → POST /api/trades/propose → confirmation state.
 *
 * Trade-card snapshots are built inline here (matching the helper
 * in TradeSummary) so the DB row captures exact price / variant
 * labels at proposal time, not whatever the client might compute
 * later. See `trade_proposals` schema comment for why the snapshot
 * matters.
 */
export function ProposeBar({
  recipientHandle,
  allCards,
  percentage,
  priceMode,
  wants,
  available,
  yourCards,
  theirCards,
  onApplyMatch,
}: ProposeBarProps) {
  const [profile, setProfile] = useState<RemoteProfile | null>(null);
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [sendState, setSendState] = useState<SendState>('idle');
  const [sentTradeId, setSentTradeId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Optional note the proposer can attach. Persisted in the DM embed's
  // description (rendered as a blockquote). Server caps at 500 chars;
  // we enforce client-side too so the textarea doesn't silently
  // accept more than the server will take.
  const [message, setMessage] = useState('');
  const [messageOpen, setMessageOpen] = useState(false);
  const autoAppliedRef = useRef(false);
  const fetchStartedRef = useRef(false);

  // One-shot profile fetch. Uses a ref for dedupe rather than
  // state-in-deps because an in-flight fetch mutating the state
  // that feeds its own dependency array would cancel itself — see
  // the auth-e2e diagnostic playbook entry in PHASE4_TESTING.md.
  useEffect(() => {
    if (!recipientHandle || fetchStartedRef.current) return;
    fetchStartedRef.current = true;

    let cancelled = false;
    setFetchState('loading');
    (async () => {
      try {
        const res = await fetch(`/api/user/${encodeURIComponent(recipientHandle)}`);
        if (cancelled) return;
        if (!res.ok) {
          setFetchState('error');
          return;
        }
        const data: RemoteProfile = await res.json();
        if (cancelled) return;
        setProfile(data);
        setFetchState('idle');
      } catch {
        if (!cancelled) setFetchState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [recipientHandle]);

  const preview = useMemo<MatchResult | null>(() => {
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
    );
  }, [profile, allCards, percentage, priceMode, wants.items, available.items]);

  // Auto-apply the match on mount exactly once so the composer
  // lands with something actionable. Later edits are the user's.
  useEffect(() => {
    if (autoAppliedRef.current) return;
    if (!preview) return;
    if (preview.offering.length === 0 && preview.receiving.length === 0) return;
    autoAppliedRef.current = true;
    onApplyMatch(
      preview.offering.map(c => ({ card: c, qty: 1 })),
      preview.receiving.map(c => ({ card: c, qty: 1 })),
    );
  }, [preview, onApplyMatch]);

  const handleSend = useCallback(async () => {
    if (sendState === 'sending' || sendState === 'sent') return;
    if (yourCards.length === 0 && theirCards.length === 0) return;

    setSendState('sending');
    setSendError(null);

    const snapshot = (cards: TradeCard[]) =>
      cards.map(tc => ({
        productId: tc.card.productId ?? '',
        // TradeCard.card.name includes the variant in parens — split
        // into base name + variant label to match the snapshot shape
        // we stored in tests (and that future DM embeds will render).
        name: tc.card.name.replace(/\s*\([^)]+\)\s*$/, ''),
        variant: extractVariantLabel(tc.card.name) || tc.card.variant || 'Standard',
        qty: tc.qty,
        unitPrice: adjustPrice(getCardPrice(tc.card, priceMode), percentage),
      }));

    try {
      const res = await fetch('/api/trades/propose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recipientHandle,
          offeringCards: snapshot(yourCards),
          receivingCards: snapshot(theirCards),
          ...(message.trim() ? { message: message.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data: { id: string; deliveryStatus?: 'delivered' | 'failed' } = await res.json();
      setSentTradeId(data.id);
      // Split the success path: row is saved either way, but if the
      // DM didn't land we want to surface that so the proposer can
      // share the trade URL manually or retry.
      setSendState(data.deliveryStatus === 'failed' ? 'sent-undelivered' : 'sent');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
      setSendState('error');
    }
  }, [sendState, yourCards, theirCards, recipientHandle, percentage, priceMode, message]);

  const body = (() => {
    if (sendState === 'sent') {
      return (
        <>
          <span className="flex-1 text-emerald-300">
            Proposal sent to <strong>@{recipientHandle}</strong>. They'll see it in a Discord DM.
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

    if (sendState === 'sent-undelivered') {
      return (
        <>
          <span className="flex-1 text-amber-200">
            Proposal saved, but Discord wouldn't let us DM <strong>@{recipientHandle}</strong> —
            they may have DMs from the bot disabled. Send them a message on Discord so they know to check.
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

    if (fetchState === 'error') {
      return (
        <span className="flex-1 text-red-300">
          Couldn't reach @{recipientHandle}'s profile — they may have made it private.
        </span>
      );
    }

    if (!profile) {
      return (
        <span className="flex-1 text-gray-400 animate-pulse">
          Loading @{recipientHandle}'s lists…
        </span>
      );
    }

    const offerCount = yourCards.reduce((n, c) => n + c.qty, 0);
    const receiveCount = theirCards.reduce((n, c) => n + c.qty, 0);
    const canSend = offerCount + receiveCount > 0 && sendState !== 'sending';

    return (
      <>
        <span className="flex-1">
          <span className="text-gray-400">Proposing to </span>
          <strong className="text-gold">@{recipientHandle}</strong>
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
          {sendState === 'sending' ? 'Sending…' : 'Send proposal'}
        </button>
      </>
    );
  })();

  const debugState = sendState === 'sent'
    ? 'sent'
    : sendState === 'sent-undelivered'
      ? 'sent-undelivered'
      : sendState === 'sending'
        ? 'sending'
        : fetchState === 'error'
          ? 'fetch-error'
          : !profile
            ? 'loading-profile'
            : sendState === 'error'
              ? 'send-error'
              : 'ready';

  return (
    <div
      className="shrink-0 px-3 pt-2 pb-3 max-w-5xl mx-auto w-full"
      data-testid="propose-bar"
      data-state={debugState}
    >
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gold/10 border border-gold/30 text-xs text-gray-200">
        {body}
      </div>
      {/* Optional message — hidden pre-send so the bar stays compact
          in its idle state. Post-send we drop the affordance entirely
          since the proposal is frozen. */}
      {profile && sendState !== 'sent' && sendState !== 'sent-undelivered' && (
        <ProposerMessageInput
          open={messageOpen}
          value={message}
          onToggle={() => setMessageOpen(o => !o)}
          onChange={setMessage}
          disabled={sendState === 'sending'}
        />
      )}
      {sendState === 'error' && sendError && (
        <div className="mt-1 text-[11px] text-red-300 px-1">
          Couldn't send: {sendError}
        </div>
      )}
      {sentTradeId && (
        <div className="mt-1 text-[10px] text-gray-500 px-1 font-mono truncate">
          Trade {sentTradeId}
        </div>
      )}
    </div>
  );
}

const MESSAGE_MAX_LENGTH = 500;

function ProposerMessageInput({
  open,
  value,
  onToggle,
  onChange,
  disabled,
}: {
  open: boolean;
  value: string;
  onToggle: () => void;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const trimmed = value.trim();
  const hasContent = trimmed.length > 0;

  return (
    <div className="mt-1.5 px-1">
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gold transition-colors"
        aria-expanded={open}
      >
        <NoteIcon className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {open
          ? 'Hide note'
          : hasContent
            ? `Note added (${trimmed.length}/${MESSAGE_MAX_LENGTH})`
            : 'Add a note'}
      </button>
      {open && (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value.slice(0, MESSAGE_MAX_LENGTH))}
          disabled={disabled}
          placeholder="Optional context for the recipient — a deck they're building for, a meetup time, etc."
          rows={2}
          maxLength={MESSAGE_MAX_LENGTH}
          className="mt-1.5 w-full bg-space-800/60 border border-space-700 rounded-md px-2.5 py-1.5 text-[11px] text-gray-100 placeholder-gray-500 resize-y min-h-[44px] focus:border-gold/50 focus:outline-none disabled:opacity-50"
          aria-label="Proposal note (optional)"
        />
      )}
    </div>
  );
}

function NoteIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}
