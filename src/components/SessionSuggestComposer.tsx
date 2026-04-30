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
 * v0 keeps this minimal — single targetSide (counterpart's), only
 * cardsToAdd suggestions, no qty tweaks (each tap = +1 qty of that
 * productId). Multi-card suggestions are built up by repeated taps;
 * a "Send N suggestions" footer commits them.
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
  }) => Promise<{ ok: true; suggestionId: string } | { ok: false; reason: string }>;
}

export function SessionSuggestComposer({
  counterpartSide,
  counterpartHandle,
  allCards,
  onClose,
  onSubmit,
}: SessionSuggestComposerProps) {
  const [draft, setDraft] = useState<TradeCardSnapshot[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = useCallback((card: CardVariant) => {
    if (!card.productId) return;
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
  }, []);

  const handleDecrement = useCallback((id: string) => {
    setDraft(prev => {
      const idx = prev.findIndex(s => s.productId === id);
      if (idx < 0) return prev;
      const current = prev[idx];
      if (current.qty <= 1) return prev.filter((_, i) => i !== idx);
      return prev.map((s, i) => i === idx ? { ...s, qty: s.qty - 1 } : s);
    });
  }, []);

  const totalCards = draft.reduce((n, s) => n + s.qty, 0);

  const handleSubmit = useCallback(async () => {
    if (draft.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await onSubmit({
      targetSide: counterpartSide,
      cardsToAdd: draft,
    });
    setSubmitting(false);
    if (result.ok) {
      onClose();
    } else {
      setError(
        result.reason === 'cap-exceeded'
          ? 'Too many pending suggestions on this session. Dismiss some first.'
          : 'Could not send the suggestion — try again.',
      );
    }
  }, [draft, submitting, counterpartSide, onSubmit, onClose]);

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
        {!error && (
          <div className="text-[11px] text-gray-500 flex-1">
            {totalCards === 0
              ? 'Tap cards to add them to your suggestion.'
              : `${totalCards} card${totalCards === 1 ? '' : 's'} ready to suggest.`}
          </div>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={draft.length === 0 || submitting}
          className="shrink-0 px-3 py-1.5 rounded-md bg-amber-500/30 border border-amber-400/60 hover:bg-amber-500/40 text-amber-50 text-xs font-bold tracking-wide uppercase transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Sending…' : 'Send suggestion'}
        </button>
      </footer>
    </div>
  );
}
