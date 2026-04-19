import { useCallback, useMemo, useState } from 'react';
import type { PriceMode, TradeCard } from '../types';
import { adjustPrice, getCardPrice } from '../services/priceService';
import { extractVariantLabel } from '../variants';
import { apiPost } from '../services/apiClient';

/**
 * Shared send-state + snapshot + message plumbing for the three
 * composer bars (ProposeBar / CounterBar / EditBar). Each bar loads
 * its own upstream data (recipient profile or existing trade) and
 * renders its own copy, but the tail end — snapshot the TradeCards,
 * POST them with an optional note, map the response into a small
 * state machine — is identical. This hook owns that tail end.
 *
 * Kept narrowly focused: the per-bar mount fetch + seed-once pattern
 * stays inline in each component because the fetch shapes differ
 * (`useRecipientProfile` vs. one-shot GET by trade id).
 */

/**
 * Minimal state machine shared by all three composers. `sent` carries
 * an optional `deliveryStatus` because Propose + Counter distinguish
 * "saved + DM landed" from "saved but DM failed" — the component
 * branches on it in its render (EditBar doesn't care, it's an edit).
 * `already-resolved` is kept as its own variant because it has
 * distinct UX copy ("beaten to the punch") unrelated to the generic
 * error bucket.
 */
export type ComposerSendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; deliveryStatus?: 'delivered' | 'failed' }
  | { kind: 'already-resolved' }
  | { kind: 'error'; message: string };

/** Mirrors the CardSnapshot shape at api/trades.ts — what the DB row
 *  stores and what the Discord embed renders. */
export interface SnapshotCard {
  productId: string;
  name: string;
  variant: string;
  qty: number;
  unitPrice: number | null;
}

interface SubmitOptions {
  endpoint: string;
  /** Extra body fields specific to the endpoint (recipientHandle,
   *  counterOfId, id, etc.). Card snapshots + optional message are
   *  merged in by the hook. */
  body: Record<string, unknown>;
  /** Optional success callback — Propose uses it to close the confirm
   *  modal + stash the returned trade id. Receives `deliveryStatus`
   *  for callers that care (warning banner) and `id` for callers that
   *  want to surface a link to the new row. */
  onSuccess?: (data: { id?: string; deliveryStatus?: 'delivered' | 'failed' }) => void;
}

export interface ComposerBarApi {
  // Message textarea state.
  message: string;
  setMessage: (m: string) => void;
  messageOpen: boolean;
  toggleMessage: () => void;
  setMessageOpen: (next: boolean) => void;

  // Send state machine.
  sendState: ComposerSendState;
  /** Manually reset the state machine. Propose uses this when the
   *  user re-opens the confirm modal after a previous error so the
   *  bar isn't stuck on 'error'. */
  resetSendState: () => void;

  /** POSTs via `apiPost`. Merges card snapshots + optional message
   *  into the caller's body. Maps the discriminated ActionResult
   *  into the state machine. */
  submit: (opts: SubmitOptions) => Promise<void>;

  /** Exposed so a caller (ProposeBar's confirm modal) can render the
   *  same snapshot it'll POST without re-running the transform. */
  buildSnapshot: (cards: TradeCard[]) => SnapshotCard[];
}

export interface UseComposerBarOptions {
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
  /** Optional max message length — defaults to 500 (server-enforced
   *  cap). Here as a knob for a future composer variant that wants a
   *  different ceiling. */
  messageMaxLength?: number;
}

const DEFAULT_MESSAGE_MAX_LENGTH = 500;

export function useComposerBar(opts: UseComposerBarOptions): ComposerBarApi {
  const { yourCards, theirCards, percentage, priceMode } = opts;
  const messageMaxLength = opts.messageMaxLength ?? DEFAULT_MESSAGE_MAX_LENGTH;

  const [message, setMessageRaw] = useState('');
  const [messageOpen, setMessageOpen] = useState(false);
  const [sendState, setSendState] = useState<ComposerSendState>({ kind: 'idle' });

  // Clip on write so callers don't need to know the cap. Same as the
  // inline `.slice(0, 500)` pattern each bar used to do on the
  // textarea onChange.
  const setMessage = useCallback(
    (next: string) => setMessageRaw(next.slice(0, messageMaxLength)),
    [messageMaxLength],
  );

  const toggleMessage = useCallback(() => setMessageOpen(o => !o), []);

  const resetSendState = useCallback(() => setSendState({ kind: 'idle' }), []);

  // Card snapshot — productId, variant-stripped name, variant label,
  // qty, adjusted unit price. Matches the prior inline closure in all
  // three components exactly.
  const buildSnapshot = useCallback(
    (cards: TradeCard[]): SnapshotCard[] =>
      cards.map(tc => ({
        productId: tc.card.productId ?? '',
        name: tc.card.name.replace(/\s*\([^)]+\)\s*$/, ''),
        variant: extractVariantLabel(tc.card.name) || tc.card.variant || 'Standard',
        qty: tc.qty,
        unitPrice: adjustPrice(getCardPrice(tc.card, priceMode), percentage),
      })),
    [percentage, priceMode],
  );

  // Memoize so ProposeBar's confirm-modal preview doesn't re-compute
  // every render. The two bars that embed this don't re-render per
  // keystroke anyway, but cheap to keep stable.
  const offeringSnapshot = useMemo(() => buildSnapshot(yourCards), [buildSnapshot, yourCards]);
  const receivingSnapshot = useMemo(() => buildSnapshot(theirCards), [buildSnapshot, theirCards]);

  const submit = useCallback(
    async ({ endpoint, body, onSuccess }: SubmitOptions) => {
      // Guard: don't POST an empty trade or re-enter while a prior
      // request is in flight / already succeeded.
      if (sendState.kind === 'sending' || sendState.kind === 'sent') return;
      if (yourCards.length === 0 && theirCards.length === 0) return;

      setSendState({ kind: 'sending' });

      const trimmed = message.trim();
      const mergedBody = {
        ...body,
        offeringCards: offeringSnapshot,
        receivingCards: receivingSnapshot,
        ...(trimmed ? { message: trimmed } : {}),
      };

      const result = await apiPost<{ id?: string; deliveryStatus?: 'delivered' | 'failed' }>(
        endpoint,
        mergedBody,
      );

      if (result.ok) {
        const deliveryStatus = result.data.deliveryStatus;
        setSendState({ kind: 'sent', deliveryStatus });
        onSuccess?.({ id: result.data.id, deliveryStatus });
        return;
      }

      if (result.reason === 'already-resolved') {
        setSendState({ kind: 'already-resolved' });
        return;
      }

      setSendState({
        kind: 'error',
        message: result.detail ?? 'Failed to send',
      });
    },
    [sendState, yourCards.length, theirCards.length, message, offeringSnapshot, receivingSnapshot],
  );

  return {
    message,
    setMessage,
    messageOpen,
    toggleMessage,
    setMessageOpen,
    sendState,
    resetSendState,
    submit,
    buildSnapshot,
  };
}
