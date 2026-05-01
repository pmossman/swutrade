import { useCallback, useState } from 'react';
import type { CardVariant } from '../types';
import { ListCardPicker } from './ListCardPicker';
import type { TradeCardSnapshot } from '../hooks/useSession';
import { extractVariantLabel } from '../variants';

/**
 * Fullscreen overlay that lets the viewer pick cards to suggest the
 * counterpart add to their side. Reuses ListCardPicker as the card-
 * search UI; the picker fires `onPick` when the user taps a tile and
 * we convert each tap into a snapshot for the suggestion payload.
 *
 * Two entry points:
 *   - "+ Suggest a card" (counterpart panel footer): opens with both
 *     drafts empty. User picks 1+ cards, hits Send → cardsToAdd flows
 *     to the suggestion.
 *   - "Suggest swap" (kebab on a counterpart card): opens with that
 *     card pre-filled into the cardsToRemove draft. User picks the
 *     replacement card(s), hits Send → cardsToAdd + cardsToRemove
 *     flow to the suggestion together.
 *
 * Submit is allowed when EITHER add OR remove draft is non-empty —
 * a swap with no replacement is just a remove suggestion (still
 * useful), and an add-only is the original flow.
 */

interface SessionSuggestComposerProps {
  /** The counterpart side ('a' or 'b' from the viewer's POV) — i.e.
   *  the targetSide for the suggestion. */
  counterpartSide: 'a' | 'b';
  counterpartHandle: string | null;
  allCards: CardVariant[];
  onClose: () => void;
  onSubmit: (args: {
    targetSide: 'a' | 'b';
    cardsToAdd: TradeCardSnapshot[];
    cardsToRemove: TradeCardSnapshot[];
  }) => Promise<{ ok: true; suggestionId: string } | { ok: false; reason: string }>;
  /** Pre-fill cardsToRemove draft. Used by the per-card "Suggest
   *  swap" entry point — opens the composer with the card already
   *  set up to be removed, leaving the user to pick the replacement. */
  initialCardsToRemove?: TradeCardSnapshot[];
  /** Productids already referenced by another pending suggestion.
   *  The composer refuses to add them — server enforces the same
   *  rule (returns 'card-locked' on submit), but blocking at pick
   *  time gives the user immediate feedback instead of a deferred
   *  error. */
  lockedProductIds?: ReadonlySet<string>;
}

export function SessionSuggestComposer({
  counterpartSide,
  counterpartHandle,
  allCards,
  onClose,
  onSubmit,
  initialCardsToRemove,
  lockedProductIds,
}: SessionSuggestComposerProps) {
  const [draft, setDraft] = useState<TradeCardSnapshot[]>([]);
  const [removeDraft, setRemoveDraft] = useState<TradeCardSnapshot[]>(() => initialCardsToRemove ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedHint, setLockedHint] = useState<string | null>(null);

  const handlePick = useCallback((card: CardVariant) => {
    if (!card.productId) return;
    // Refuse picks for productIds already locked by another pending
    // suggestion. Surface a transient hint so the user understands
    // why the tap didn't register — silent-ignore would feel broken.
    if (lockedProductIds?.has(card.productId)) {
      setLockedHint(`${card.name} is already in a pending suggestion.`);
      window.setTimeout(() => setLockedHint(null), 2400);
      return;
    }
    const snapshot: TradeCardSnapshot = {
      productId: card.productId,
      name: card.name,
      variant: extractVariantLabel(card.name),
      qty: 1,
      unitPrice: card.marketPrice ?? null,
    };
    setDraft(prev => {
      const idx = prev.findIndex(s => s.productId === snapshot.productId);
      if (idx >= 0) {
        return prev.map((s, i) => i === idx ? { ...s, qty: s.qty + 1 } : s);
      }
      return [...prev, snapshot];
    });
  }, [lockedProductIds]);

  const handleDecrement = useCallback((id: string) => {
    setDraft(prev => {
      const idx = prev.findIndex(s => s.productId === id);
      if (idx < 0) return prev;
      const current = prev[idx];
      if (current.qty <= 1) return prev.filter((_, i) => i !== idx);
      return prev.map((s, i) => i === idx ? { ...s, qty: s.qty - 1 } : s);
    });
  }, []);

  const removeRemoval = useCallback((productId: string) => {
    setRemoveDraft(prev => prev.filter(c => c.productId !== productId));
  }, []);

  const addCount = draft.reduce((n, s) => n + s.qty, 0);
  const removeCount = removeDraft.reduce((n, s) => n + s.qty, 0);
  const hasContent = addCount > 0 || removeCount > 0;

  const handleSubmit = useCallback(async () => {
    if (!hasContent || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await onSubmit({
      targetSide: counterpartSide,
      cardsToAdd: draft,
      cardsToRemove: removeDraft,
    });
    setSubmitting(false);
    if (result.ok) {
      onClose();
    } else {
      setError(
        result.reason === 'cap-exceeded'
          ? 'Too many pending suggestions on this session. Dismiss some first.'
          : result.reason === 'card-locked'
            ? 'One of these cards is already in a pending suggestion. Drop it and try again.'
            : 'Could not send the suggestion — try again.',
      );
    }
  }, [hasContent, draft, removeDraft, submitting, counterpartSide, onSubmit, onClose]);

  return (
    <div className="fixed inset-0 z-40 bg-space-900 flex flex-col">
      <header className="shrink-0 px-4 py-3 border-b border-space-800 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] tracking-[0.25em] text-gray-500 uppercase">Suggest changes</div>
          <div className="text-sm font-semibold text-gray-100 truncate">
            to @{counterpartHandle ?? 'counterpart'}'s side
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-1 text-gray-500 hover:text-gray-200 transition-colors text-lg leading-none"
          aria-label="Close suggest composer"
        >
          ×
        </button>
      </header>

      {removeDraft.length > 0 && (
        <RemovingStrip cards={removeDraft} onRemoveOne={removeRemoval} />
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        <ListCardPicker
          selectionMode={{ kind: 'specific' }}
          allCards={allCards}
          priceMode="market"
          actionTarget="suggestion"
          savedEntries={draft.map(s => ({
            id: s.productId,
            productId: s.productId,
            qty: s.qty,
          }))}
          onPick={handlePick}
          onDecrement={handleDecrement}
          onClose={onClose}
        />
      </div>

      <footer className="shrink-0 px-3 py-2 border-t border-space-800 flex items-center gap-2">
        {error && (
          <div className="text-[11px] text-red-400 flex-1 truncate">{error}</div>
        )}
        {!error && lockedHint && (
          <div className="text-[11px] text-amber-300 flex-1 truncate">{lockedHint}</div>
        )}
        {!error && !lockedHint && (
          <div className="text-[11px] text-gray-500 flex-1">
            {!hasContent
              ? 'Tap cards to add them to your suggestion.'
              : (() => {
                  const parts: string[] = [];
                  if (addCount > 0) parts.push(`+${addCount}`);
                  if (removeCount > 0) parts.push(`-${removeCount}`);
                  const summary = parts.join(' · ');
                  return `${summary} ready to suggest.`;
                })()}
          </div>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!hasContent || submitting}
          className="shrink-0 px-3 py-1.5 rounded-md bg-amber-500/30 border border-amber-400/60 hover:bg-amber-500/40 text-amber-50 text-xs font-bold tracking-wide uppercase transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Sending…' : 'Send suggestion'}
        </button>
      </footer>
    </div>
  );
}

/**
 * Pill row above the picker showing cards staged for removal in this
 * suggestion. Each pill has an X to drop it from the suggestion (in
 * case the user changed their mind after opening the swap composer).
 * Hidden when the remove draft is empty.
 */
function RemovingStrip({
  cards,
  onRemoveOne,
}: {
  cards: TradeCardSnapshot[];
  onRemoveOne: (productId: string) => void;
}) {
  return (
    <div className="shrink-0 px-3 py-2 border-b border-space-800 bg-red-950/15">
      <div className="text-[10px] font-bold uppercase tracking-wider text-red-300 mb-1.5">
        Removing
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {cards.map(card => (
          <li
            key={`${card.productId}-${card.variant}`}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md border border-red-500/40 bg-red-950/30 text-[11px] text-red-100"
          >
            <span className="font-bold tabular-nums">×{card.qty}</span>
            <span className="truncate max-w-[160px]">{card.name}</span>
            {card.variant && card.variant !== 'Standard' && (
              <span className="text-[10px] text-red-300/70 shrink-0">({card.variant})</span>
            )}
            <button
              type="button"
              onClick={() => onRemoveOne(card.productId)}
              aria-label={`Drop ${card.name} from suggestion`}
              className="ml-1 px-1 text-red-300 hover:text-red-100 transition-colors leading-none"
              title="Drop from suggestion"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
