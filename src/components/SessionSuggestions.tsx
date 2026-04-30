import { useState } from 'react';
import type { PendingSuggestionView, SessionView, TradeCardSnapshot } from '../hooks/useSession';

/**
 * Pending-suggestions strip for the active session canvas. Renders
 * each non-dismissed suggestion as its own card with kind-aware
 * controls:
 *   - target receives [Accept] [Dismiss]
 *   - suggester sees [Withdraw] (also a dismiss, but framed as their
 *     own action)
 *
 * Residual delta is highlighted — if the user has already partially
 * satisfied the suggestion via direct edits, the still-pending
 * portion is what's shown. Already-satisfied items render struck
 * through so the user understands what's progressed.
 */

interface SessionSuggestionsProps {
  session: SessionView;
  onAccept: (suggestionId: string) => Promise<{ ok: boolean }>;
  onDismiss: (suggestionId: string) => Promise<{ ok: boolean }>;
}

export function SessionSuggestions({ session, onAccept, onDismiss }: SessionSuggestionsProps) {
  const counterpartHandle = session.counterpart?.handle ?? null;
  const suggestions = session.suggestions ?? [];

  if (suggestions.length === 0) return null;

  return (
    <section
      className="rounded-xl border border-amber-500/30 bg-amber-950/15 p-3 flex flex-col gap-2"
      aria-label="Pending suggestions"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-bold tracking-[0.2em] uppercase text-amber-300">
          Pending suggestions
        </div>
        <div className="text-[10px] text-amber-300/70 tabular-nums">
          {suggestions.length}
        </div>
      </header>
      <ul className="flex flex-col gap-2">
        {suggestions.map(suggestion => (
          <SuggestionRow
            key={suggestion.id}
            suggestion={suggestion}
            counterpartHandle={counterpartHandle}
            onAccept={onAccept}
            onDismiss={onDismiss}
          />
        ))}
      </ul>
    </section>
  );
}

interface SuggestionRowProps {
  suggestion: PendingSuggestionView;
  counterpartHandle: string | null;
  onAccept: (suggestionId: string) => Promise<{ ok: boolean }>;
  onDismiss: (suggestionId: string) => Promise<{ ok: boolean }>;
}

function SuggestionRow({ suggestion, counterpartHandle, onAccept, onDismiss }: SuggestionRowProps) {
  const [busy, setBusy] = useState<'accept' | 'dismiss' | null>(null);

  const fromActor = suggestion.suggestedByViewer
    ? 'You'
    : `@${counterpartHandle ?? 'counterpart'}`;
  const targetActor = suggestion.targetIsViewer
    ? 'your side'
    : `@${counterpartHandle ?? 'counterpart'}'s side`;

  // Categorize the cards into still-pending residual (shown bold)
  // vs already-satisfied originals (shown struck-through). We
  // compute this by diffing the residual against the original
  // cardsToAdd / cardsToRemove arrays.
  const residualAddIds = new Set(suggestion.residualAdd.map(c => c.productId));
  const residualRemoveIds = new Set(suggestion.residualRemove.map(c => c.productId));

  const handleAccept = async () => {
    setBusy('accept');
    try {
      await onAccept(suggestion.id);
    } finally {
      setBusy(null);
    }
  };
  const handleDismiss = async () => {
    setBusy('dismiss');
    try {
      await onDismiss(suggestion.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="rounded-lg border border-amber-500/25 bg-amber-950/20 p-2.5 flex flex-col gap-2">
      <div className="text-[11px] text-amber-100/90">
        <span className="font-semibold">{fromActor}</span>
        <span className="text-amber-200/60"> suggests changes to </span>
        <span className="font-semibold">{targetActor}</span>
      </div>

      {suggestion.cardsToAdd.length > 0 && (
        <CardChunk
          label="Add"
          tone="add"
          cards={suggestion.cardsToAdd}
          residualIds={residualAddIds}
          residualCards={suggestion.residualAdd}
        />
      )}
      {suggestion.cardsToRemove.length > 0 && (
        <CardChunk
          label="Remove"
          tone="remove"
          cards={suggestion.cardsToRemove}
          residualIds={residualRemoveIds}
          residualCards={suggestion.residualRemove}
        />
      )}

      <div className="flex items-center gap-2 pt-1">
        {suggestion.targetIsViewer ? (
          <>
            <button
              type="button"
              onClick={handleAccept}
              disabled={!!busy}
              className="px-3 py-1.5 rounded-md bg-amber-500/30 border border-amber-400/60 hover:bg-amber-500/40 text-amber-50 text-xs font-bold tracking-wide uppercase transition-colors disabled:opacity-50"
            >
              {busy === 'accept' ? 'Applying…' : 'Accept'}
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              disabled={!!busy}
              className="px-3 py-1.5 rounded-md border border-space-700 hover:border-gray-500 text-gray-400 hover:text-gray-200 text-xs font-semibold transition-colors disabled:opacity-50"
            >
              {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={handleDismiss}
            disabled={!!busy}
            className="px-3 py-1.5 rounded-md border border-space-700 hover:border-gray-500 text-gray-400 hover:text-gray-200 text-xs font-semibold transition-colors disabled:opacity-50"
          >
            {busy === 'dismiss' ? 'Withdrawing…' : 'Withdraw'}
          </button>
        )}
      </div>
    </li>
  );
}

interface CardChunkProps {
  label: string;
  tone: 'add' | 'remove';
  cards: TradeCardSnapshot[];
  residualIds: Set<string>;
  residualCards: TradeCardSnapshot[];
}

function CardChunk({ label, tone, cards, residualIds, residualCards }: CardChunkProps) {
  // Lookup of residual qty by productId so we can show "still need
  // 2 of 3" when the user has added some on their own.
  const residualByPid = new Map(residualCards.map(c => [c.productId, c.qty]));

  return (
    <div className="flex flex-col gap-0.5">
      <div className={`text-[10px] font-bold uppercase tracking-wider ${
        tone === 'add' ? 'text-emerald-300' : 'text-red-300'
      }`}>
        {label}
      </div>
      <ul className="flex flex-col gap-0.5 text-[12px]">
        {cards.map(card => {
          const isPending = residualIds.has(card.productId);
          const residualQty = residualByPid.get(card.productId);
          const showQty = residualQty !== undefined && residualQty !== card.qty
            ? `${residualQty}/${card.qty}`
            : `${card.qty}`;
          return (
            <li
              key={`${card.productId}-${card.variant}`}
              className={isPending ? 'text-gray-100' : 'text-gray-500 line-through'}
            >
              <span className="font-semibold tabular-nums">×{showQty}</span>
              <span className="ml-1.5">{card.name}</span>
              {card.variant && card.variant !== 'Standard' && (
                <span className="ml-1 text-[10px] text-gray-500">({card.variant})</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
