import { useEffect, useMemo, useState } from 'react';
import { AppHeader } from './ui/AppHeader';
import { LoadingState, ErrorState, EmptyState } from './ui/states';
import { useAuthContext } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { relativeTime } from '../utils/relativeTime';
import { apiGet } from '../services/apiClient';
import type { SessionView } from '../hooks/useSession';

type Tab = 'active' | 'history';

interface SessionRowEntry {
  id: string;
  status: SessionView['status'];
  counterpart: SessionView['counterpart'];
  yourCount: number;
  theirCount: number;
  lastEditedAt: string;
  openSlot: boolean;
  cancelReason: SessionView['cancelReason'];
  awaitingViewer: boolean;
}

/**
 * /?trades=1 — every shared trade session involving the viewer.
 *
 * Two tabs:
 *   - **Active** — sessions still in flight (status='active'). Open-slot
 *     sessions (creator waiting for a QR scan) get a hint that no
 *     counterpart has joined yet.
 *   - **History** — terminal sessions (settled / cancelled / expired).
 *     Read-only.
 *
 * Default tab is chosen based on which bucket has rows: if there's
 * any active session, land on Active; otherwise History. This view
 * replaced a far more complex incoming/outgoing/history/shared
 * surface that existed when proposals were a parallel trade
 * primitive — Phase C consolidated everything onto sessions, so the
 * page becomes a simple two-tab list. Selection / bulk-resolve /
 * accept-decline-counter actions all moved to the per-session canvas
 * at `/s/<code>`.
 */
export function TradesHistoryView() {
  const auth = useAuthContext();
  const nav = useNavigation();
  const [sessions, setSessions] = useState<SessionRowEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tab, setTab] = useState<Tab | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await apiGet<{ sessions: SessionView[] }>(
        '/api/me/sessions?include=terminal',
      );
      if (cancelled) return;
      if (!result.ok) {
        setStatus('error');
        return;
      }
      const projected: SessionRowEntry[] = result.data.sessions.map(s => ({
        id: s.id,
        status: s.status,
        counterpart: s.counterpart,
        yourCount: s.yourCards.reduce((n, c) => n + c.qty, 0),
        theirCount: s.theirCards.reduce((n, c) => n + c.qty, 0),
        lastEditedAt: s.lastEditedAt,
        openSlot: s.openSlot,
        cancelReason: s.cancelReason,
        awaitingViewer: s.awaitingViewer,
      }));
      projected.sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt));
      setSessions(projected);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, []);

  const { active, history } = useMemo(() => {
    const a: SessionRowEntry[] = [];
    const h: SessionRowEntry[] = [];
    for (const s of sessions) {
      if (s.status === 'active') a.push(s);
      else h.push(s);
    }
    return { active: a, history: h };
  }, [sessions]);

  // Default tab once data lands. Active wins if there's anything
  // in flight; otherwise History.
  useEffect(() => {
    if (tab !== null || status !== 'ready') return;
    setTab(active.length > 0 ? 'active' : 'history');
  }, [tab, status, active.length]);

  const activeTab: Tab = tab ?? 'active';
  const visible = activeTab === 'active' ? active : history;

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <AppHeader
        auth={auth}
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'My trades' },
        ]}
      />

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-4 max-w-3xl mx-auto w-full flex flex-col gap-4">
        <header className="flex items-baseline justify-between gap-3 pb-3 border-b border-space-800">
          <div>
            <h1 className="text-lg font-bold text-gray-100">My trades</h1>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Shared trade sessions you're part of, active and resolved.
            </p>
          </div>
        </header>

        <TabBar
          activeTab={activeTab}
          onSelect={setTab}
          activeCount={active.length}
          historyCount={history.length}
        />

        {status === 'loading' && <LoadingState label="Loading trades…" />}
        {status === 'error' && <ErrorState>Couldn't load your trades. Try refreshing.</ErrorState>}
        {status === 'ready' && visible.length === 0 && (
          <EmptyState
            title={activeTab === 'active' ? 'No active trades' : 'No past trades yet'}
          >
            {activeTab === 'active'
              ? "You're not in any shared trades right now. Start one from a profile page or from the trade builder."
              : "Trades you've settled, cancelled, or that have expired will show up here."}
          </EmptyState>
        )}
        {status === 'ready' && visible.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {visible.map(row => (
              <li key={row.id}>
                <SessionListRow
                  row={row}
                  onOpen={() => nav.toSession(row.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function TabBar({
  activeTab,
  onSelect,
  activeCount,
  historyCount,
}: {
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
  activeCount: number;
  historyCount: number;
}) {
  return (
    <div className="flex border-b border-space-800 -mx-3 sm:-mx-6 px-3 sm:px-6">
      {(['active', 'history'] as const).map(t => {
        const count = t === 'active' ? activeCount : historyCount;
        const label = t === 'active' ? 'Active' : 'History';
        const selected = activeTab === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onSelect(t)}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-wider border-b-2 -mb-px transition-colors ${
              selected
                ? 'text-gold border-gold'
                : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}
          >
            {label}
            {count > 0 && (
              <span className={`ml-1.5 text-[10px] tabular-nums ${selected ? 'text-gold' : 'text-gray-600'}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SessionListRow({
  row,
  onOpen,
}: {
  row: SessionRowEntry;
  onOpen: () => void;
}) {
  const counterpartLabel = row.counterpart
    ? `@${row.counterpart.handle}${row.counterpart.isAnonymous ? ' (guest)' : ''}`
    : row.openSlot ? 'Waiting for someone to join' : 'Unknown trader';
  const when = relativeTime(row.lastEditedAt);
  const stateLabel = stateBadgeLabel(row);
  const stateTone = stateBadgeTone(row);
  const highlight = row.awaitingViewer && row.status === 'active';
  const containerClass = highlight
    ? 'bg-gold/8 border-gold/40 hover:border-gold/60'
    : 'bg-space-800/40 border-space-700 hover:border-gold/30';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors ${containerClass}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
          <span className="text-sm font-medium text-gray-100 truncate">
            {counterpartLabel}
          </span>
          <span className={`shrink-0 px-1.5 h-[18px] inline-flex items-center rounded text-[9px] tracking-wider uppercase font-bold ${stateTone}`}>
            {stateLabel}
          </span>
        </div>
        <div className="text-[11px] text-gray-500 mt-0.5 truncate">
          {row.yourCount} offered · {row.theirCount} received · {when}
        </div>
      </div>
      <span aria-hidden className="text-gray-600 text-sm">›</span>
    </button>
  );
}

function stateBadgeLabel(row: SessionRowEntry): string {
  if (row.status === 'active') return row.openSlot ? 'Invite' : 'Shared';
  if (row.status === 'cancelled') {
    return row.cancelReason === 'declined' ? 'Declined' : 'Cancelled';
  }
  if (row.status === 'settled') return 'Settled';
  if (row.status === 'expired') return 'Expired';
  return row.status;
}

function stateBadgeTone(row: SessionRowEntry): string {
  if (row.status === 'active') return 'bg-cyan-900/40 border border-cyan-500/40 text-cyan-200';
  if (row.status === 'settled') return 'bg-emerald-900/40 border border-emerald-500/40 text-emerald-300';
  if (row.status === 'cancelled' && row.cancelReason === 'declined') {
    return 'bg-red-900/40 border border-red-500/40 text-red-300';
  }
  return 'bg-space-700/60 border border-space-600 text-gray-400';
}
