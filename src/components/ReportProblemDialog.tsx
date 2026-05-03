import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { apiPost } from '../services/apiClient';
import { formatPrice } from '../services/priceService';
import { ErrorState } from './ui/states';

/**
 * Reusable feedback / problem-report dialog. Two flavors:
 *
 *   - `kind: 'price'` — triggered from a card's kebab menu when the
 *     user thinks the displayed price is wrong. Renders a structured
 *     read-only header showing the card + price the user was looking
 *     at so they don't have to retype it. The same fields ride
 *     through to the Discord embed so triage can cross-check
 *     TCGPlayer with the productId.
 *
 *   - `kind: 'general'` — triggered from the nav menu's "Report a
 *     problem" item. No structured context beyond the page URL the
 *     user was on (captured automatically at submit time).
 *
 * Server: POSTs to `/api/me/feedback`, which fires fire-and-forget
 * to a Discord channel. Returns 204 even when the webhook isn't
 * configured (e.g. local dev), so the user always sees the success
 * state — that's intentional. The error path here surfaces only on
 * client / network / 4xx errors.
 *
 * Mirrors NudgeDialog's Radix pattern (S4.7) for focus-trap +
 * scroll-lock + ESC handling.
 */

interface PriceContext {
  productId?: string;
  cardName?: string;
  variant?: string;
  ourPrice?: number | null;
  priceMode?: 'market' | 'low';
}

type ReportProblemDialogProps =
  | {
      open: boolean;
      onClose: () => void;
      kind: 'price';
      /** Card context shown read-only above the textarea + serialized
       *  into the Discord embed. */
      context: PriceContext;
    }
  | {
      open: boolean;
      onClose: () => void;
      kind: 'general';
      context?: undefined;
    };

const MAX_MESSAGE_LENGTH = 1000;

export function ReportProblemDialog(props: ReportProblemDialogProps) {
  const { open, onClose, kind } = props;
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // Reset transient state every time the dialog reopens — yesterday's
  // half-typed report shouldn't ghost in.
  useEffect(() => {
    if (open) {
      setMessage('');
      setSubmitting(false);
      setErrorMessage(null);
      setSubmitted(false);
    }
  }, [open]);

  const placeholder = kind === 'price'
    ? "What's wrong with this price? (e.g. should be ~$1.50, not $4)"
    : 'Tell us what happened…';

  const title = kind === 'price' ? 'Report inaccurate price' : 'Report a problem';
  const sublabel = kind === 'price'
    ? "We'll cross-check this card against TCGPlayer."
    : "We'll get back to you on Discord if needed. Pasting steps to reproduce helps.";

  async function handleSubmit() {
    const trimmed = message.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    setErrorMessage(null);
    const context = kind === 'price'
      ? { ...props.context, pageUrl: window.location.href }
      : { pageUrl: window.location.href };
    const result = await apiPost('/api/me/feedback', {
      kind,
      message: trimmed,
      context,
    });
    setSubmitting(false);
    if (!result.ok) {
      setErrorMessage(result.detail ?? "Couldn't send your report. Try again in a moment.");
      return;
    }
    setSubmitted(true);
    // Auto-close shortly after so the user sees the confirmation
    // without manually dismissing. 1.2s reads as deliberate without
    // feeling slow.
    window.setTimeout(() => onClose(), 1200);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100vw-2rem)] max-w-md rounded-xl bg-space-900 border border-space-700 p-5 shadow-xl"
        >
          <Dialog.Title className="text-sm font-bold text-gray-100 mb-1">
            {title}
          </Dialog.Title>
          <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
            {sublabel}
          </p>

          {kind === 'price' && <PriceContextPreview context={props.context} />}

          <label htmlFor="report-message" className="sr-only">Your message</label>
          <textarea
            id="report-message"
            value={message}
            onChange={e => setMessage(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
            disabled={submitting || submitted}
            placeholder={placeholder}
            rows={4}
            maxLength={MAX_MESSAGE_LENGTH}
            className="w-full bg-space-800/60 border border-space-700 rounded-md px-3 py-2 text-xs text-gray-100 placeholder-gray-500 resize-y min-h-[88px] focus:border-gold/50 focus:outline-none disabled:opacity-50"
          />
          <div className="flex items-center justify-between mt-1 text-[10px] text-gray-500">
            <span>{message.trim().length}/{MAX_MESSAGE_LENGTH}</span>
          </div>

          {errorMessage && (
            <ErrorState variant="line" role="alert" className="mt-3">
              {errorMessage}
            </ErrorState>
          )}

          {submitted && (
            <div
              role="status"
              className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-200"
            >
              Thanks — your report was sent.
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={submitting}
                className="px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-medium text-gray-300 hover:text-gold transition-colors disabled:opacity-50"
              >
                {submitted ? 'Close' : 'Cancel'}
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || submitted || message.trim().length === 0}
              className="px-4 h-9 rounded-lg bg-gold text-space-900 font-bold text-xs hover:bg-gold-bright transition-colors disabled:opacity-60 disabled:cursor-wait"
            >
              {submitting ? 'Sending…' : submitted ? 'Sent' : 'Send'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PriceContextPreview({ context }: { context: PriceContext }) {
  const hasAny = context.cardName || context.productId || context.ourPrice !== undefined;
  if (!hasAny) return null;
  const priceLabel = context.ourPrice === undefined
    ? null
    : `${formatPrice(context.ourPrice ?? null)}${context.priceMode ? ` (${context.priceMode})` : ''}`;
  return (
    <div className="mb-3 rounded-md bg-space-800/40 border border-space-700 px-3 py-2 text-[11px] text-gray-400 leading-relaxed">
      {context.cardName && (
        <div className="text-gray-200 font-semibold truncate">{context.cardName}</div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
        {context.variant && <span>Variant: <span className="text-gray-300">{context.variant}</span></span>}
        {priceLabel && <span>Our price: <span className="text-gold tabular-nums">{priceLabel}</span></span>}
      </div>
    </div>
  );
}
