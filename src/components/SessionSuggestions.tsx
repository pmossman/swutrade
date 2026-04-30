import { useState } from 'react';
import type { PendingSuggestionView, TradeCardSnapshot } from '../hooks/useSession';

/**
 * Three-shape suggestion UI components, each anchored to where the
 * suggestion would land:
 *
 *   - <InlineSuggestionList> renders inside a TradeSide's aboveCardList
 *     slot. Two contexts:
 *       * incoming (target = viewer): viewer's own panel; suggestions
 *         show "@A suggests +N to your side · tap to review" with
 *         Accept / Dismiss controls when expanded.
 *       * outgoing (target = counterpart): counterpart's panel;
 *         suggestions show "You suggested +N · withdraw" with the
 *         original delta in the expanded body.
 *
 *   - <RevertSuggestionBanner> renders ABOVE the trade canvas — both-
 *     side reverts don't belong to one panel. Same collapsed-pill /
 *     tap-to-expand pattern; expanded body shows both sides side-by-
 *     side with Accept / Withdraw controls.
 *
 * All three default to collapsed so a long suggestion (e.g. 8 cards)
 * doesn't dominate the trade canvas. Tap to expand reveals the
 * residual delta in a scrollable region.
 */

interface InlineSuggestionListProps {
  /** Cross-side suggestions ('a' or 'b' targetSide) filtered for this
   *  panel. Caller picks: viewer's-panel = `targetIsViewer === true`;
   *  counterpart-panel = `suggestedByViewer === true`. */
  suggestions: PendingSuggestionView[];
  counterpartHandle: string | null;
  onAccept: (suggestionId: string) => Promise<{ ok: boolean }>;
  onDismiss: (suggestionId: string) => Promise<{ ok: boolean }>;
}

export function InlineSuggestionList({
  suggestions,
  counterpartHandle,
  onAccept,
  onDismiss,
}: InlineSuggestionListProps) {
  if (suggestions.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 px-3 py-2">
      {suggestions.map(s => (
        <InlineSuggestionPill
          key={s.id}
          suggestion={s}
          counterpartHandle={counterpartHandle}
          onAccept={onAccept}
          onDismiss={onDismiss}
        />
      ))}
    </ul>
  );
}

interface InlineSuggestionPillProps {
  suggestion: PendingSuggestionView;
  counterpartHandle: string | null;
  onAccept: (suggestionId: string) => Promise<{ ok: boolean }>;
  onDismiss: (suggestionId: string) => Promise<{ ok: boolean }>;
}

function InlineSuggestionPill({
  suggestion,
  counterpartHandle,
  onAccept,
  onDismiss,
}: InlineSuggestionPillProps) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'accept' | 'dismiss' | null>(null);

  const fromActor = suggestion.suggestedByViewer ? 'You' : `@${counterpartHandle ?? 'counterpart'}`;
  const verb = suggestion.targetIsViewer ? 'suggests' : 'suggested';

  // Build a compact summary string — "+2 · -1" etc. Uses residual
  // counts when a partial fulfillment exists so the user sees what's
  // still pending, not the original delta.
  const addCount = suggestion.residualAdd.reduce((n, c) => n + c.qty, 0);
  const removeCount = suggestion.residualRemove.reduce((n, c) => n + c.qty, 0);
  const summary = [
    addCount > 0 ? `+${addCount}` : null,
    removeCount > 0 ? `-${removeCount}` : null,
  ].filter(Boolean).join(' · ') || 'no change';

  const handleAccept = async () => {
    setBusy('accept');
    try { await onAccept(suggestion.id); } finally { setBusy(null); }
  };
  const handleDismiss = async () => {
    setBusy('dismiss');
    try { await onDismiss(suggestion.id); } finally { setBusy(null); }
  };

  return (
    <li className="rounded-md border border-amber-500/30 bg-amber-950/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        aria-label={`${fromActor} ${verb} ${summary}`}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-amber-900/20 transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0 text-[12px] text-amber-100">
          <svg
            viewBox="0 0 16 16"
            className={`w-3 h-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {/* Space-joined text spans render with real whitespace so
              both screen readers and Playwright getByText see "You
              suggested +1" not "Yousuggested+1". CSS gap between
              flex children doesn't create text-node whitespace. */}
          <span className="font-semibold shrink-0">{fromActor}</span>
          <span className="text-amber-200/70 shrink-0">{' '}{verb}</span>
          <span className="font-bold tabular-nums text-amber-50 shrink-0">{' '}{summary}</span>
        </span>
        <span className="text-[10px] text-amber-300/70 shrink-0 uppercase tracking-wide">
          {expanded ? 'hide' : 'review'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-amber-500/20 bg-space-900/30 px-2.5 py-2 flex flex-col gap-2">
          {suggestion.cardsToAdd.length > 0 && (
            <SuggestionCardLines
              label="Add"
              tone="add"
              originals={suggestion.cardsToAdd}
              residuals={suggestion.residualAdd}
            />
          )}
          {suggestion.cardsToRemove.length > 0 && (
            <SuggestionCardLines
              label="Remove"
              tone="remove"
              originals={suggestion.cardsToRemove}
              residuals={suggestion.residualRemove}
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
        </div>
      )}
    </li>
  );
}

interface SuggestionCardLinesProps {
  label: string;
  tone: 'add' | 'remove';
  originals: TradeCardSnapshot[];
  residuals: TradeCardSnapshot[];
}

function SuggestionCardLines({ label, tone, originals, residuals }: SuggestionCardLinesProps) {
  const residualByPid = new Map(residuals.map(c => [c.productId, c.qty]));
  return (
    <div className="flex flex-col gap-0.5">
      <div className={`text-[10px] font-bold uppercase tracking-wider ${
        tone === 'add' ? 'text-emerald-300' : 'text-red-300'
      }`}>
        {label}
      </div>
      {/* Scroll cap — long suggestions stay readable without
          dominating the panel. ~140px ≈ 6 rows; beyond that scrolls. */}
      <ul className="flex flex-col gap-0.5 text-[12px] max-h-[140px] overflow-y-auto">
        {originals.map(card => {
          const residualQty = residualByPid.get(card.productId);
          const isPending = residualQty !== undefined;
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

interface RevertSuggestionBannerProps {
  /** Filtered to revert-shaped suggestions only (`targetSide === 'both'`). */
  suggestions: PendingSuggestionView[];
  counterpartHandle: string | null;
  onAccept: (suggestionId: string) => Promise<{ ok: boolean }>;
  onDismiss: (suggestionId: string) => Promise<{ ok: boolean }>;
}

export function RevertSuggestionBanner({
  suggestions,
  counterpartHandle,
  onAccept,
  onDismiss,
}: RevertSuggestionBannerProps) {
  if (suggestions.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {suggestions.map(s => (
        <RevertSuggestionPill
          key={s.id}
          suggestion={s}
          counterpartHandle={counterpartHandle}
          onAccept={onAccept}
          onDismiss={onDismiss}
        />
      ))}
    </ul>
  );
}

function RevertSuggestionPill({
  suggestion,
  counterpartHandle,
  onAccept,
  onDismiss,
}: InlineSuggestionPillProps) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'accept' | 'dismiss' | null>(null);

  const fromActor = suggestion.suggestedByViewer ? 'You' : `@${counterpartHandle ?? 'counterpart'}`;
  const snapshot = suggestion.bothSidesSnapshot;
  const aCount = snapshot ? snapshot.yourCards.length : 0;
  const bCount = snapshot ? snapshot.theirCards.length : 0;

  const handleAccept = async () => {
    setBusy('accept');
    try { await onAccept(suggestion.id); } finally { setBusy(null); }
  };
  const handleDismiss = async () => {
    setBusy('dismiss');
    try { await onDismiss(suggestion.id); } finally { setBusy(null); }
  };

  return (
    <li className="rounded-lg border border-amber-500/30 bg-amber-950/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        aria-label={`${fromActor} proposed reverting both sides (${aCount} + ${bCount} cards)`}
        className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-amber-900/20 transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0 text-[12px] text-amber-100">
          <svg
            viewBox="0 0 16 16"
            className={`w-3 h-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="font-semibold">{fromActor}</span>
          <span className="text-amber-200/70">{' '}proposed reverting both sides</span>
          <span className="text-[10px] text-amber-300/70 tabular-nums">
            {' '}({aCount}+{bCount} cards)
          </span>
        </span>
        <span className="text-[10px] text-amber-300/70 shrink-0 uppercase tracking-wide">
          {expanded ? 'hide' : 'review'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-amber-500/20 bg-space-900/30 px-3 py-2 flex flex-col gap-2">
          {snapshot && (
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <div className="rounded bg-space-900/40 border border-space-700 p-1.5">
                <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">Your side</div>
                <SnapshotCardList cards={snapshot.yourCards} />
              </div>
              <div className="rounded bg-space-900/40 border border-space-700 p-1.5">
                <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">
                  @{counterpartHandle ?? 'counterpart'}'s side
                </div>
                <SnapshotCardList cards={snapshot.theirCards} />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            {!suggestion.suggestedByViewer ? (
              <>
                <button
                  type="button"
                  onClick={handleAccept}
                  disabled={!!busy}
                  className="px-3 py-1.5 rounded-md bg-amber-500/30 border border-amber-400/60 hover:bg-amber-500/40 text-amber-50 text-xs font-bold tracking-wide uppercase transition-colors disabled:opacity-50"
                >
                  {busy === 'accept' ? 'Reverting…' : '↶ Accept revert'}
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
        </div>
      )}
    </li>
  );
}

function SnapshotCardList({ cards }: { cards: TradeCardSnapshot[] }) {
  if (cards.length === 0) {
    return <div className="text-[11px] text-gray-600 italic">empty</div>;
  }
  return (
    <ul className="flex flex-col gap-0.5 text-[11px] max-h-[120px] overflow-y-auto">
      {cards.map(card => (
        <li key={`${card.productId}-${card.variant}`} className="text-gray-200">
          <span className="font-semibold tabular-nums">×{card.qty}</span>
          <span className="ml-1.5 truncate">{card.name}</span>
          {card.variant && card.variant !== 'Standard' && (
            <span className="ml-1 text-[10px] text-gray-500">({card.variant})</span>
          )}
        </li>
      ))}
    </ul>
  );
}
