import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionEvent, SessionView, TradeCardSnapshot } from '../hooks/useSession';
import { cardImageUrl } from '../services/priceService';

/**
 * Timeline + chat panel for an active trade session. Renders a unified
 * stream of timeline events (chat messages, edits, confirmations, …)
 * with a chat input pinned at the bottom. Mounted as a slide-in overlay
 * so it doesn't compete with the two-side trade canvas for vertical
 * real estate; toggled open/closed by the parent.
 *
 * Event-rendering policy:
 *   chat         → message bubble with author + time
 *   edited       → "X edited their side" one-liner
 *   confirmed    → "X confirmed" one-liner
 *   unconfirmed  → "Confirmations cleared" one-liner
 *   settled      → "Trade settled" milestone
 *   cancelled    → "Trade cancelled" milestone
 *   expired      → "Trade expired" milestone
 *   created      → "Session created" anchor
 *   edit-snapshot → filtered out server-side (revert source, not display)
 *   notified     → skipped (system telemetry, not user-visible)
 */

interface SessionTimelinePanelProps {
  session: SessionView;
  /** Closes the panel. Caller decides whether to also clear focus. */
  onClose: () => void;
  sendChat: (body: string) => Promise<{ ok: true } | { ok: false; reason: 'rate-limited' | 'invalid' | 'error' }>;
  /** Propose a revert to the given snapshot event id (PR 3). The
   *  panel renders edit-snapshot events with a "↶ Revert here"
   *  affordance that fires this. */
  proposeRevert: (snapshotEventId: string) => Promise<{ ok: true; suggestionId: string } | { ok: false; reason: string }>;
}

export function SessionTimelinePanel({ session, onClose, sendChat, proposeRevert }: SessionTimelinePanelProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Server returns events newest-first; reverse for chronological
  // top-to-bottom render. Filter out system-internal events
  // ('notified') AND the paired 'edit-snapshot' rows — those carry
  // the snapshot payload for the revert flow but don't belong in the
  // user-visible timeline. Each `edited` event references its
  // companion snapshot via payload.snapshotEventId, so the revert
  // affordance can hang off the edited row's kebab menu without a
  // visible snapshot pill.
  const visibleEvents = useMemo(() => {
    return [...session.events]
      .filter(e => e.type !== 'notified' && e.type !== 'edit-snapshot')
      .reverse();
  }, [session.events]);

  const handleRevert = async (snapshotEventId: string) => {
    setRevertingId(snapshotEventId);
    setRevertError(null);
    const result = await proposeRevert(snapshotEventId);
    setRevertingId(null);
    if (!result.ok) {
      setRevertError(
        result.reason === 'no-op'
          ? 'Already at this state — nothing to revert.'
          : "Couldn't propose revert — try again.",
      );
    }
  };

  // Auto-scroll to bottom when new events arrive (chat-app convention).
  // Only auto-scrolls if user is already near the bottom — avoids
  // hijacking scroll when they're reviewing earlier history.
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const anchor = scrollAnchorRef.current;
    if (!el || !anchor) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) {
      anchor.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [visibleEvents.length]);

  const handleSend = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    const result = await sendChat(trimmed);
    setSending(false);
    if (result.ok) {
      setDraft('');
      return;
    }
    setError(
      result.reason === 'rate-limited'
        ? 'Slow down a moment — too many messages.'
        : result.reason === 'invalid'
          ? 'Message must be 1-500 characters.'
          : "Couldn't send — try again.",
    );
  }, [draft, sending, sendChat]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const counterpartHandle = session.counterpart?.handle ?? 'Your counterpart';
  const terminal = session.status !== 'active';

  // visualViewport tracking — older iOS (< 16.4) ignores the
  // interactive-widget viewport meta and keeps the layout viewport at
  // its full height when the keyboard opens. Without an explicit
  // height stamp the panel ends up taller than the visible area, the
  // chat input gets auto-scrolled into view, and the rest of the page
  // peeks through above and below. We mirror visualViewport.height
  // into a CSS var so the panel always matches the visible region.
  const [vvHeight, setVvHeight] = useState<number | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const sync = () => setVvHeight(vv.height);
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/40"
      onClick={onClose}
      style={vvHeight ? { height: `${vvHeight}px` } : undefined}
    >
      <div
        // h-full inherits the parent's pinned visualViewport height.
        // Modern browsers also benefit from interactive-widget=resizes-content
        // in the viewport meta, but the inline height pin works on
        // older iOS versions that ignore it.
        className="w-full max-w-md h-full bg-space-900 border-l border-space-700 flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-space-800">
          <div className="min-w-0">
            <div className="text-[10px] tracking-[0.25em] text-gray-500 uppercase">Activity</div>
            <div className="text-sm font-semibold text-gray-100 truncate">
              with @{counterpartHandle}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close activity"
            className="shrink-0 px-2 py-1 text-gray-500 hover:text-gray-200 transition-colors text-lg leading-none"
          >
            ×
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
          {revertError && (
            <div className="text-[11px] text-red-400 px-2 py-1 rounded border border-red-500/30 bg-red-950/20">
              {revertError}
            </div>
          )}
          {visibleEvents.length === 0 ? (
            <EmptyState />
          ) : (
            visibleEvents.map(event => {
              // Edited events carry their paired snapshot id in payload —
              // hand the revert callback bound to that id so the kebab
              // menu can fire propose-revert without searching for the
              // snapshot row.
              const snapshotId = event.type === 'edited' && typeof event.payload?.snapshotEventId === 'string'
                ? event.payload.snapshotEventId
                : null;
              return (
                <EventRow
                  key={event.id}
                  event={event}
                  counterpartHandle={counterpartHandle}
                  onRevert={snapshotId ? () => handleRevert(snapshotId) : undefined}
                  reverting={snapshotId ? revertingId === snapshotId : false}
                />
              );
            })
          )}
          <div ref={scrollAnchorRef} />
        </div>

        {!terminal && (
          <footer className="shrink-0 border-t border-space-800 px-3 py-2">
            {error && (
              <div className="text-[11px] text-red-400 mb-1">{error}</div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Send a message…"
                rows={1}
                maxLength={500}
                className="flex-1 resize-none rounded-md border border-space-700 bg-space-800/60 px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-600 focus:border-gold/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={sending || draft.trim().length === 0}
                className="shrink-0 px-3 py-1.5 rounded-md bg-gold/20 border border-gold/40 hover:bg-gold/30 hover:border-gold/60 text-gold text-xs font-bold tracking-wide uppercase transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Send
              </button>
            </div>
            <div className="text-[10px] text-gray-600 mt-1">
              Enter to send, Shift+Enter for new line.
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center text-[12px] text-gray-500 py-8">
      No activity yet. Send a message to start the conversation.
    </div>
  );
}

function EventRow({
  event,
  counterpartHandle,
  onRevert,
  reverting,
}: {
  event: SessionEvent;
  counterpartHandle: string;
  onRevert?: () => void;
  reverting?: boolean;
}) {
  const actor = event.actorIsViewer ? 'You' : `@${counterpartHandle}`;
  const time = formatTime(event.createdAt);

  if (event.type === 'chat') {
    const body = typeof event.payload?.body === 'string' ? event.payload.body : '';
    return (
      <div className={`flex flex-col ${event.actorIsViewer ? 'items-end' : 'items-start'}`}>
        <div
          className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm whitespace-pre-wrap break-words ${
            event.actorIsViewer
              ? 'bg-emerald-900/40 text-emerald-100 border border-emerald-800/40'
              : 'bg-space-800 text-gray-100 border border-space-700'
          }`}
        >
          {body}
        </div>
        <div className="text-[10px] text-gray-600 mt-0.5 px-1">
          {actor} · {time}
        </div>
      </div>
    );
  }

  // 'edited' events render as a card-diff panel with a kebab menu
  // for the (rarely-used) "↶ Revert here" affordance. Fall through to
  // the simple one-liner for legacy events that don't carry the diff
  // payload (anything recorded before the diff enrichment landed).
  if (event.type === 'edited') {
    const added = Array.isArray(event.payload?.added) ? event.payload.added as TradeCardSnapshot[] : [];
    const removed = Array.isArray(event.payload?.removed) ? event.payload.removed as TradeCardSnapshot[] : [];
    const viaSuggestion = typeof event.payload?.viaSuggestion === 'string';
    const side = event.payload?.side;

    if (added.length > 0 || removed.length > 0) {
      // Wording: when the actor IS the viewer ("you"), the side
      // expression is "your side." Otherwise it's "their side." The
      // earlier blanket "edited their side" was wrong from the
      // viewer's POV when they themselves did the edit.
      const sideLabel = event.actorIsViewer ? 'your side' : 'their side';
      const headline = viaSuggestion && side === 'both'
        ? `${actor} accepted a revert`
        : viaSuggestion
          ? `${actor} accepted a suggestion`
          : `${actor} edited ${sideLabel}`;

      return (
        <div className="rounded-md border border-space-700 bg-space-800/40 px-2.5 py-1.5">
          <div className="flex items-start justify-between gap-2 mb-1">
            <div className="text-[11px] text-gray-400 italic">{headline} · {time}</div>
            {onRevert && (
              <RevertKebab onRevert={onRevert} reverting={reverting ?? false} />
            )}
          </div>
          {added.length > 0 && (
            <CardDiffSection label="Added" tone="add" cards={added} />
          )}
          {removed.length > 0 && (
            <CardDiffSection label="Removed" tone="remove" cards={removed} />
          )}
        </div>
      );
    }
    // No diff payload — legacy event, fall through to one-liner.
  }

  // Structured event — small one-liner with subtle chrome.
  const summary = summarizeStructuredEvent(event, actor);
  if (!summary) return null;
  return (
    <div className="text-[11px] text-gray-500 italic text-center py-1">
      {summary} · {time}
    </div>
  );
}

/**
 * Kebab menu hanging off each edited-event row. Default-collapsed
 * because the revert path is rarely used — the prominent "↶ Revert
 * here" pill from the previous iteration trained the eye on a
 * destructive action it didn't need to see. Click opens a small
 * popover with the revert option; click anywhere else closes.
 */
function RevertKebab({ onRevert, reverting }: { onRevert: () => void; reverting: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="More actions"
        aria-expanded={open}
        className="px-1 -mt-0.5 -mr-0.5 text-gray-500 hover:text-gray-200 transition-colors text-base leading-none"
      >
        ⋮
      </button>
      {open && (
        <>
          {/* Backdrop swallow-clicks to dismiss the popover. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div className="absolute right-0 top-full z-40 mt-1 rounded-md border border-space-700 bg-space-900 shadow-lg overflow-hidden min-w-[10rem]">
            <button
              type="button"
              onClick={() => { setOpen(false); onRevert(); }}
              disabled={reverting}
              className="w-full text-left px-3 py-1.5 text-[11px] text-amber-200 hover:bg-amber-900/30 disabled:opacity-50 transition-colors"
              title="Propose a revert to this state — counterpart accepts to apply"
            >
              {reverting ? 'Sending…' : '↶ Revert to this state'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Compact card list for the diff section of an 'edited' event. Small
 * thumbnail + name + qty so the user can recognize cards at a glance
 * without leaving the timeline. Capped via overflow-y-auto so a
 * 20-card edit doesn't dominate the panel.
 */
function CardDiffSection({
  label,
  tone,
  cards,
}: {
  label: string;
  tone: 'add' | 'remove';
  cards: TradeCardSnapshot[];
}) {
  return (
    <div className="flex flex-col gap-0.5 mb-1 last:mb-0">
      <div className={`text-[9px] font-bold uppercase tracking-wider ${
        tone === 'add' ? 'text-emerald-300' : 'text-red-300'
      }`}>
        {label}
      </div>
      <ul className="flex flex-col gap-1 max-h-[180px] overflow-y-auto">
        {cards.map(card => {
          const thumb = card.productId ? cardImageUrl(card.productId, 'sm') : null;
          return (
            <li key={`${card.productId}-${card.variant}`} className="flex items-center gap-1.5 text-[12px] text-gray-200">
              {thumb && (
                <img
                  src={thumb}
                  alt=""
                  loading="lazy"
                  className="w-6 h-8 rounded-sm object-cover bg-space-900 shrink-0"
                />
              )}
              <span className="font-bold tabular-nums text-gray-100">×{card.qty}</span>
              <span className="truncate">{card.name}</span>
              {card.variant && card.variant !== 'Standard' && (
                <span className="text-[10px] text-gray-500 shrink-0">({card.variant})</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function summarizeStructuredEvent(event: SessionEvent, actor: string): string | null {
  switch (event.type) {
    case 'created':
      return 'Session opened';
    case 'edited': {
      const count = typeof event.payload?.count === 'number' ? event.payload.count : null;
      const viaSuggestion = typeof event.payload?.viaSuggestion === 'string';
      const side = event.payload?.side;
      if (viaSuggestion && side === 'both') {
        return `${actor} accepted a revert`;
      }
      if (viaSuggestion) {
        return `${actor} accepted a suggestion`;
      }
      return count != null
        ? `${actor} edited their side (${count} card${count === 1 ? '' : 's'})`
        : `${actor} edited their side`;
    }
    case 'confirmed':
      return `${actor} confirmed`;
    case 'unconfirmed': {
      const cleared = typeof event.payload?.cleared === 'number' ? event.payload.cleared : null;
      return cleared
        ? `Confirmations cleared (${cleared})`
        : 'Confirmations cleared';
    }
    case 'settled':
      return 'Trade settled';
    case 'cancelled':
      return `${actor} cancelled the session`;
    case 'expired':
      return 'Session expired';
    case 'suggestion-created': {
      const kind = event.payload?.kind === 'revert' ? 'revert' : 'suggestion';
      return `${actor} proposed a ${kind}`;
    }
    case 'suggestion-accepted':
      // The matching 'edited' event renders the user-visible "applied"
      // line; this one is internal bookkeeping.
      return null;
    case 'suggestion-dismissed': {
      const reason = event.payload?.reason;
      if (reason === 'satisfied') return 'A suggestion was satisfied and cleared';
      if (reason === 'unactionable') return 'A suggestion was no longer actionable';
      return `${actor} dismissed a suggestion`;
    }
    default:
      return null;
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' · '
    + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
