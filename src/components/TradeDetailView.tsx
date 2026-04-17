import { useState } from 'react';
import { Logo } from './Logo';
import { BetaBadge } from './BetaBadge';
import {
  useTradeDetail,
  type CardSnapshot,
  type TradeStatus,
  type UserStub,
} from '../hooks/useTradeDetail';

interface TradeDetailViewProps {
  tradeId: string;
  onClose: () => void;
}

/**
 * /?trade=<id> — single proposal detail page. Shows the full
 * payload, a status badge, chain-context links if this is part of
 * a counter chain, and a Cancel button when the viewer is the
 * proposer and the trade is still pending.
 *
 * No chain walking — just one-hop links to the parent / child so
 * the user can navigate the chain if they want. Full timeline
 * rendering is a separate feature (if we ever need it).
 */
export function TradeDetailView({ tradeId, onClose }: TradeDetailViewProps) {
  const { trade, status, cancel, cancelling } = useTradeDetail(tradeId);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const handleCancel = async () => {
    setCancelError(null);
    const result = await cancel();
    if (result === 'already-resolved') {
      setCancelError('This proposal was just resolved by the recipient — reload to see the new state.');
    } else if (result === 'error') {
      setCancelError('Couldn\'t cancel. Try again in a moment.');
    }
  };

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
          <span className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">Trade proposal</span>
        </div>
      </header>

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-2 max-w-3xl mx-auto w-full" data-testid="trade-detail">
        {status === 'loading' && (
          <div className="mt-6 text-xs text-gray-500 animate-pulse">Loading…</div>
        )}
        {status === 'not-found' && (
          <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-3 text-sm text-red-300">
            Trade not found — it may have been deleted or sent to someone else.
          </div>
        )}
        {status === 'error' && (
          <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-3 text-sm text-red-300">
            Couldn't load this trade. Try refreshing.
          </div>
        )}

        {status === 'ready' && trade && (
          <article className="flex flex-col gap-5 mt-5" data-status={trade.status}>
            {/* Header: direction + counterpart + status */}
            <section className="flex flex-wrap items-center gap-3">
              <CounterpartAvatar
                user={trade.viewerIsProposer ? trade.recipient : trade.proposer}
              />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">
                  {trade.viewerIsProposer ? 'You proposed to' : 'You received from'}
                </div>
                <div className="text-sm sm:text-base font-semibold text-gray-100 truncate">
                  @{(trade.viewerIsProposer ? trade.recipient : trade.proposer)?.handle ?? 'unknown'}
                </div>
              </div>
              <StatusBadge status={trade.status} />
            </section>

            {/* Chain context */}
            {(trade.counterOfStub || trade.counteredByStub) && (
              <section className="flex flex-col gap-1.5 text-[11px]">
                {trade.counterOfStub && (
                  <a
                    href={`/?trade=${encodeURIComponent(trade.counterOfStub.id)}`}
                    className="inline-flex items-center gap-1.5 text-gray-400 hover:text-gold transition-colors"
                  >
                    <ArrowIcon className="w-3 h-3 rotate-180" />
                    Counter to an earlier proposal
                  </a>
                )}
                {trade.counteredByStub && (
                  <a
                    href={`/?trade=${encodeURIComponent(trade.counteredByStub.id)}`}
                    className="inline-flex items-center gap-1.5 text-gray-400 hover:text-gold transition-colors"
                  >
                    <ArrowIcon className="w-3 h-3" />
                    Countered by a follow-up proposal
                  </a>
                )}
              </section>
            )}

            {/* Note from proposer */}
            {trade.message && (
              <section className="rounded-lg border border-gold/20 bg-gold/5 px-3 py-2.5 text-xs text-gray-200 italic">
                "{trade.message}"
              </section>
            )}

            {/* Cards */}
            <CardGroup
              label={trade.viewerIsProposer ? "You're offering" : "They're offering you"}
              tone="emerald"
              cards={trade.offeringCards}
            />
            <CardGroup
              label={trade.viewerIsProposer ? "They'd give you" : "They want from you"}
              tone="blue"
              cards={trade.receivingCards}
            />

            {/* Cancel button (proposer + pending only) */}
            {trade.viewerIsProposer && trade.status === 'pending' && (
              <section className="flex flex-col gap-2 items-start">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="px-3 py-1.5 rounded-md bg-red-500/10 border border-red-500/40 text-red-300 text-xs font-bold hover:bg-red-500/20 hover:border-red-400/60 transition-colors disabled:opacity-50 disabled:cursor-wait"
                >
                  {cancelling ? 'Cancelling…' : 'Cancel this proposal'}
                </button>
                {cancelError && (
                  <div className="text-[11px] text-red-300">{cancelError}</div>
                )}
              </section>
            )}

            {/* Timestamps */}
            <section className="text-[10px] text-gray-500 space-y-0.5 pt-2 border-t border-space-800">
              <div>Proposed {new Date(trade.createdAt).toLocaleString()}</div>
              {trade.respondedAt && (
                <div>
                  {trade.status === 'accepted' && 'Accepted '}
                  {trade.status === 'declined' && 'Declined '}
                  {trade.status === 'cancelled' && 'Cancelled '}
                  {trade.status === 'countered' && 'Countered '}
                  {new Date(trade.respondedAt).toLocaleString()}
                </div>
              )}
            </section>
          </article>
        )}
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: TradeStatus }) {
  const variants: Record<TradeStatus, { label: string; cls: string }> = {
    pending: { label: 'Pending', cls: 'bg-gold/20 border-gold/40 text-gold' },
    accepted: { label: 'Accepted', cls: 'bg-emerald-500/20 border-emerald-400/50 text-emerald-200' },
    declined: { label: 'Declined', cls: 'bg-red-500/20 border-red-400/50 text-red-200' },
    cancelled: { label: 'Cancelled', cls: 'bg-space-700/60 border-space-600 text-gray-400' },
    expired: { label: 'Expired', cls: 'bg-space-700/60 border-space-600 text-gray-400' },
    countered: { label: 'Countered', cls: 'bg-purple-500/20 border-purple-400/50 text-purple-200' },
  };
  const v = variants[status];
  return (
    <span className={`px-2 py-0.5 rounded-md border text-[10px] tracking-wider uppercase font-bold shrink-0 ${v.cls}`}>
      {v.label}
    </span>
  );
}

function CounterpartAvatar({ user }: { user: UserStub | null }) {
  if (user?.avatarUrl) {
    return <img src={user.avatarUrl} alt="" className="w-10 h-10 rounded-full shrink-0" />;
  }
  const initial = (user?.username ?? '?').trim().slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden
      className="w-10 h-10 rounded-full bg-space-700 text-gold font-bold flex items-center justify-center shrink-0 text-sm"
    >
      {initial}
    </span>
  );
}

function CardGroup({
  label,
  tone,
  cards,
}: {
  label: string;
  tone: 'emerald' | 'blue';
  cards: CardSnapshot[];
}) {
  const toneClasses = tone === 'emerald'
    ? 'border-emerald-500/30'
    : 'border-blue-500/30';
  const accent = tone === 'emerald' ? 'text-emerald-300' : 'text-blue-300';
  const total = cards.reduce((n, c) => n + (c.unitPrice ?? 0) * c.qty, 0);

  return (
    <section>
      <div className="flex items-baseline justify-between mb-1.5">
        <h2 className={`text-[11px] tracking-[0.18em] uppercase font-bold ${accent}`}>{label}</h2>
        {total > 0 && (
          <span className="text-[11px] text-gray-400 tabular-nums">${total.toFixed(2)}</span>
        )}
      </div>
      {cards.length === 0 ? (
        <div className="rounded-lg border border-space-700 bg-space-800/40 px-3 py-2 text-[11px] text-gray-500 italic">
          None
        </div>
      ) : (
        <ul className={`flex flex-col rounded-lg border ${toneClasses} bg-space-800/40 divide-y divide-space-800 overflow-hidden`}>
          {cards.map((c, i) => (
            <li key={i} className="flex items-center gap-2 px-3 py-2 text-xs">
              <span className="text-gray-500 tabular-nums shrink-0 w-6">{c.qty}×</span>
              <span className="flex-1 min-w-0 truncate text-gray-100">{c.name}</span>
              <span className="text-[10px] text-gray-500 tracking-wider uppercase shrink-0">{c.variant}</span>
              {c.unitPrice !== null && c.unitPrice > 0 && (
                <span className="text-[11px] text-gray-400 tabular-nums shrink-0 w-14 text-right">
                  ${(c.unitPrice * c.qty).toFixed(2)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BackIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 4l-4 4 4 4" />
    </svg>
  );
}

function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}
