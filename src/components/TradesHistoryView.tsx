import { PageHeader } from './ui/PageHeader';
import { StatusBadge } from './ui/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from './ui/states';
import { useTradesList, type TradeListEntry } from '../hooks/useTradesList';
import type { UserStub } from '../hooks/useTradeDetail';

interface TradesHistoryViewProps {
  onClose: () => void;
}

/**
 * /?trades=1 — list of proposals involving the viewer. Sent and
 * received in one stream, newest-first by updated_at. Each row
 * links through to /?trade=<id> for the full detail + cancel
 * affordance. Flat for MVP — chain-collapsing (grouping a counter
 * thread under one row) can come later.
 */
export function TradesHistoryView({ onClose }: TradesHistoryViewProps) {
  const { proposals, status } = useTradesList();

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <div className="px-3 sm:px-6 pt-3 pb-2 max-w-3xl mx-auto w-full">
        <PageHeader onBack={onClose} kicker="My trades" />
      </div>

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-2 max-w-3xl mx-auto w-full" data-testid="trades-history">
        {status === 'loading' && <LoadingState className="mt-6" />}
        {status === 'error' && (
          <ErrorState className="mt-6">Couldn't load your trades. Try refreshing.</ErrorState>
        )}
        {status === 'ready' && proposals.length === 0 && (
          <EmptyState className="mt-6" title="No trade proposals yet.">
            Send one from a community member's profile — or when someone proposes a trade to you,
            it'll show up here too.
          </EmptyState>
        )}
        {status === 'ready' && proposals.length > 0 && (
          <ul className="flex flex-col gap-2 mt-5">
            {proposals.map(p => (
              <li key={p.id}>
                <TradeRow proposal={p} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function TradeRow({ proposal }: { proposal: TradeListEntry }) {
  const href = `/?trade=${encodeURIComponent(proposal.id)}`;
  const isSent = proposal.direction === 'sent';
  return (
    <a
      href={href}
      className="flex items-center gap-3 p-3 rounded-lg border border-space-700 bg-space-800/40 hover:border-gold/30 hover:bg-space-800 transition-colors"
    >
      <DirectionIcon sent={isSent} />
      <CounterpartAvatar user={proposal.counterpart} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[11px] tracking-wider uppercase text-gray-500 font-bold">
            {isSent ? 'Sent to' : 'From'}
          </span>
          <span className="text-sm font-semibold text-gray-100 truncate">
            @{proposal.counterpart?.handle ?? 'unknown'}
          </span>
          {proposal.counterOfId && (
            <span className="text-[10px] text-purple-300 tracking-wider uppercase font-bold">
              Counter
            </span>
          )}
        </div>
        <div className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
          <span>
            Offer <strong className="text-emerald-300">{proposal.offeringCount}</strong>
            <span className="mx-1">↔</span>
            Receive <strong className="text-blue-300">{proposal.receivingCount}</strong>
          </span>
          <span>·</span>
          <span>{relativeTime(proposal.updatedAt)}</span>
        </div>
      </div>
      <StatusBadge status={proposal.status} />
    </a>
  );
}

function DirectionIcon({ sent }: { sent: boolean }) {
  return (
    <span className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
      sent ? 'bg-emerald-500/15 text-emerald-300' : 'bg-blue-500/15 text-blue-300'
    }`}>
      <svg viewBox="0 0 16 16" className={`w-3.5 h-3.5 ${sent ? '' : 'rotate-180'}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 8h10M9 4l4 4-4 4" />
      </svg>
    </span>
  );
}

function CounterpartAvatar({ user }: { user: UserStub | null }) {
  if (user?.avatarUrl) {
    return <img src={user.avatarUrl} alt="" className="w-8 h-8 rounded-full shrink-0" />;
  }
  const initial = (user?.username ?? '?').trim().slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden
      className="w-8 h-8 rounded-full bg-space-700 text-gold font-bold flex items-center justify-center shrink-0 text-xs"
    >
      {initial}
    </span>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
