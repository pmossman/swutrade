import { Logo } from './Logo';
import { BetaBadge } from './BetaBadge';
import { useTradesList, type TradeListEntry } from '../hooks/useTradesList';
import type { TradeStatus, UserStub } from '../hooks/useTradeDetail';

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
      <header className="px-3 sm:px-6 pt-3 pb-2 max-w-3xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <h1 className="relative flex items-center select-none shrink-0">
            <Logo className="w-6 h-6 sm:w-7 sm:h-7 shrink-0" />
            <span className="ml-px text-sm sm:text-lg font-bold tracking-[0.1em] sm:tracking-[0.12em] leading-none">
              <span className="text-gray-200 uppercase">SWU</span><span className="text-gold uppercase">Trade</span>
            </span>
            <BetaBadge className="absolute bottom-0 left-7 sm:left-8 translate-y-[calc(100%-2px)]" />
          </h1>
          <div className="ml-auto">
            <button
              type="button"
              onClick={onClose}
              aria-label="Back"
              className="flex items-center gap-1 px-3 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-400 hover:text-gold"
            >
              <BackIcon className="w-3.5 h-3.5" />
              Back
            </button>
          </div>
        </div>
        <div className="mt-3">
          <span className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">My trades</span>
        </div>
      </header>

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-2 max-w-3xl mx-auto w-full" data-testid="trades-history">
        {status === 'loading' && (
          <div className="mt-6 text-xs text-gray-500 animate-pulse">Loading…</div>
        )}
        {status === 'error' && (
          <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-3 text-sm text-red-300">
            Couldn't load your trades. Try refreshing.
          </div>
        )}
        {status === 'ready' && proposals.length === 0 && (
          <div className="mt-6 rounded-lg border border-space-700 bg-space-800/40 px-4 py-6 text-sm text-gray-400 leading-relaxed">
            <p className="font-semibold text-gray-200 mb-2">No trade proposals yet.</p>
            <p className="text-xs text-gray-500">
              Send one from a community member's profile — or when someone proposes a trade to you,
              it'll show up here too.
            </p>
          </div>
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
      <StatusChip status={proposal.status} />
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

function StatusChip({ status }: { status: TradeStatus }) {
  const variants: Record<TradeStatus, { label: string; cls: string }> = {
    pending: { label: 'Pending', cls: 'bg-gold/15 border-gold/30 text-gold' },
    accepted: { label: 'Accepted', cls: 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200' },
    declined: { label: 'Declined', cls: 'bg-red-500/15 border-red-400/40 text-red-200' },
    cancelled: { label: 'Cancelled', cls: 'bg-space-700 border-space-600 text-gray-400' },
    expired: { label: 'Expired', cls: 'bg-space-700 border-space-600 text-gray-400' },
    countered: { label: 'Countered', cls: 'bg-purple-500/15 border-purple-400/40 text-purple-200' },
  };
  const v = variants[status];
  return (
    <span className={`px-2 py-0.5 rounded-md border text-[10px] tracking-wider uppercase font-bold shrink-0 ${v.cls}`}>
      {v.label}
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

function BackIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 4l-4 4 4 4" />
    </svg>
  );
}
