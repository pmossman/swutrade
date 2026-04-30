import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionEvent, SessionView } from '../hooks/useSession';

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
}

export function SessionTimelinePanel({ session, onClose, sendChat }: SessionTimelinePanelProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Server returns events newest-first; reverse for chronological
  // top-to-bottom render. Skip event types that aren't user-meaningful.
  const visibleEvents = useMemo(() => {
    return [...session.events]
      .filter(e => e.type !== 'notified' && e.type !== 'edit-snapshot')
      .reverse();
  }, [session.events]);

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

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <div
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
          {visibleEvents.length === 0 ? (
            <EmptyState />
          ) : (
            visibleEvents.map(event => (
              <EventRow
                key={event.id}
                event={event}
                counterpartHandle={counterpartHandle}
              />
            ))
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

function EventRow({ event, counterpartHandle }: { event: SessionEvent; counterpartHandle: string }) {
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

  // Structured event — small one-liner with subtle chrome.
  const summary = summarizeStructuredEvent(event, actor);
  if (!summary) return null;
  return (
    <div className="text-[11px] text-gray-500 italic text-center py-1">
      {summary} · {time}
    </div>
  );
}

function summarizeStructuredEvent(event: SessionEvent, actor: string): string | null {
  switch (event.type) {
    case 'created':
      return 'Session opened';
    case 'edited': {
      const count = typeof event.payload?.count === 'number' ? event.payload.count : null;
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
