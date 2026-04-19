import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from './ui/PageHeader';
import { StatusBadge } from './ui/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from './ui/states';
import { NudgeDialog } from './NudgeDialog';
import { useTradesList, type TradeListEntry } from '../hooks/useTradesList';
import type { UserStub } from '../hooks/useTradeDetail';
import {
  acceptProposal,
  cancelProposal,
  declineProposal,
  nudgeProposal,
  type ActionResult,
} from '../services/tradeActions';

type Tab = 'incoming' | 'outgoing' | 'history';

interface TradesHistoryViewProps {
  onClose: () => void;
}

/**
 * /?trades=1 — proposals involving the viewer, split into three tabs:
 *
 *   - **Incoming** — pending proposals where the viewer is the recipient.
 *     Row actions: Accept, Counter (deep-link), Decline.
 *   - **Outgoing** — pending proposals where the viewer is the proposer.
 *     Row actions: Edit (deep-link), Nudge, Cancel.
 *   - **History** — everything else (accepted / declined / cancelled /
 *     expired / countered), read-only.
 *
 * Default tab is chosen based on which bucket has pending activity —
 * we lean toward the surface the user probably came here to handle,
 * not an alphabetical first tab. Empty-state copy is distinct per
 * tab so the user knows *why* it's empty. The full-empty case
 * (no proposals at all) preserves the legacy "No trade proposals
 * yet" text so the existing e2e still matches.
 */
export function TradesHistoryView({ onClose }: TradesHistoryViewProps) {
  const { proposals, status, refresh } = useTradesList();
  const [tab, setTab] = useState<Tab | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [nudgeTarget, setNudgeTarget] = useState<TradeListEntry | null>(null);

  const { incoming, outgoing, history } = useMemo(() => {
    const inc: TradeListEntry[] = [];
    const out: TradeListEntry[] = [];
    const hist: TradeListEntry[] = [];
    for (const p of proposals) {
      if (p.status === 'pending' && p.direction === 'received') inc.push(p);
      else if (p.status === 'pending' && p.direction === 'sent') out.push(p);
      else hist.push(p);
    }
    return { incoming: inc, outgoing: out, history: hist };
  }, [proposals]);

  // Pick a default tab once data arrives. Heuristic: whichever bucket
  // has pending work (leaning toward Incoming, since that's the user's
  // direct obligation) else fall through to History. The user can of
  // course flip tabs from there.
  useEffect(() => {
    if (tab !== null) return;
    if (status !== 'ready') return;
    if (incoming.length > 0) setTab('incoming');
    else if (outgoing.length > 0) setTab('outgoing');
    else setTab('history');
  }, [tab, status, incoming.length, outgoing.length]);

  const activeTab: Tab = tab ?? 'incoming';
  const activeList: TradeListEntry[] = activeTab === 'incoming'
    ? incoming
    : activeTab === 'outgoing'
      ? outgoing
      : history;

  const handleRowAction = useCallback(async (
    action: 'cancel' | 'accept' | 'decline',
    entry: TradeListEntry,
  ) => {
    setRowError(null);
    // ActionResult is parameterized per-endpoint but we only need the
    // ok/reason shape at the row level — downcast the responses to
    // the plain shape so a single handler covers all three actions.
    const run = async (): Promise<ActionResult> => {
      if (action === 'cancel') return cancelProposal(entry.id);
      if (action === 'accept') {
        const r = await acceptProposal(entry.id);
        return r.ok ? { ok: true, data: {} } : r;
      }
      const r = await declineProposal(entry.id);
      return r.ok ? { ok: true, data: {} } : r;
    };
    const result = await run();
    if (result.ok) {
      await refresh();
      return;
    }
    if (result.reason === 'already-resolved') {
      setRowError('That proposal was just resolved — refreshing…');
      await refresh();
      return;
    }
    setRowError(result.detail ?? 'Something went wrong. Try again.');
  }, [refresh]);

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <div className="px-3 sm:px-6 pt-3 pb-2 max-w-3xl mx-auto w-full">
        <PageHeader onBack={onClose} kicker="My trades" />
      </div>

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-2 max-w-3xl mx-auto w-full" data-testid="trades-history">
        <TabBar
          active={activeTab}
          onSelect={setTab}
          counts={{
            incoming: incoming.length,
            outgoing: outgoing.length,
            history: history.length,
          }}
        />

        {rowError && (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
            {rowError}
          </div>
        )}

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

        {status === 'ready' && proposals.length > 0 && activeList.length === 0 && (
          <EmptyTabState tab={activeTab} />
        )}

        {status === 'ready' && activeList.length > 0 && (
          <ul className="flex flex-col gap-2 mt-5">
            {activeList.map(p => (
              <li key={p.id}>
                <TradeRow
                  proposal={p}
                  tab={activeTab}
                  onCancel={() => handleRowAction('cancel', p)}
                  onAccept={() => handleRowAction('accept', p)}
                  onDecline={() => handleRowAction('decline', p)}
                  onNudge={() => setNudgeTarget(p)}
                />
              </li>
            ))}
          </ul>
        )}
      </main>

      {nudgeTarget && (
        <NudgeDialog
          open={true}
          recipientHandle={nudgeTarget.counterpart?.handle ?? 'them'}
          onClose={() => setNudgeTarget(null)}
          onNudge={async note => {
            const result = await nudgeProposal(nudgeTarget.id, note);
            if (result.ok) await refresh();
            return result;
          }}
        />
      )}
    </div>
  );
}

function TabBar({
  active,
  onSelect,
  counts,
}: {
  active: Tab;
  onSelect: (tab: Tab) => void;
  counts: { incoming: number; outgoing: number; history: number };
}) {
  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: 'incoming', label: 'Incoming', count: counts.incoming },
    { id: 'outgoing', label: 'Outgoing', count: counts.outgoing },
    { id: 'history', label: 'History', count: counts.history },
  ];
  return (
    <div role="tablist" aria-label="My trades" className="flex gap-1 mt-3 border-b border-space-800">
      {tabs.map(t => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(t.id)}
            className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-semibold transition-colors ${
              isActive ? 'text-gold' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <span>{t.label}</span>
            {t.count > 0 && (
              <span className={`text-[10px] tabular-nums px-1.5 rounded-full ${
                isActive && t.id !== 'history'
                  ? 'bg-gold/20 text-gold'
                  : 'bg-space-800 text-gray-400'
              }`}>
                {t.count}
              </span>
            )}
            {isActive && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-gold" />}
          </button>
        );
      })}
    </div>
  );
}

function EmptyTabState({ tab }: { tab: Tab }) {
  if (tab === 'incoming') {
    return (
      <EmptyState className="mt-6" title="No incoming proposals right now.">
        When someone proposes a trade to you, it'll appear here with quick Accept / Counter / Decline
        actions. Check the Outgoing tab for trades you've sent.
      </EmptyState>
    );
  }
  if (tab === 'outgoing') {
    return (
      <EmptyState className="mt-6" title="You haven't sent any pending proposals.">
        Visit a community member's profile and click <strong>Trade with @them</strong> to send one.
      </EmptyState>
    );
  }
  return (
    <EmptyState className="mt-6" title="No resolved trades yet.">
      Accepted, declined, cancelled, and countered trades show up here as an archive.
    </EmptyState>
  );
}

function TradeRow({
  proposal,
  tab,
  onCancel,
  onAccept,
  onDecline,
  onNudge,
}: {
  proposal: TradeListEntry;
  tab: Tab;
  onCancel: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onNudge: () => void;
}) {
  const isSent = proposal.direction === 'sent';
  // Row-level action cluster is role-aware:
  //   incoming (pending) → Accept / Counter (anchor) / Decline
  //   outgoing (pending) → Edit (anchor) / Nudge / Cancel
  //   history           → no actions, row just opens the detail
  const showIncomingActions = tab === 'incoming' && proposal.status === 'pending';
  const showOutgoingActions = tab === 'outgoing' && proposal.status === 'pending';
  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg border border-space-700 bg-space-800/40 hover:border-gold/30 hover:bg-space-800 transition-colors">
      <a
        href={`/?trade=${encodeURIComponent(proposal.id)}`}
        className="flex items-center gap-3 min-w-0"
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
            {proposal.topCard && (
              <>
                <span>·</span>
                <span className="truncate">{proposal.topCard.name}</span>
              </>
            )}
          </div>
        </div>
        <StatusBadge status={proposal.status} />
      </a>

      {(showIncomingActions || showOutgoingActions) && (
        <div className="flex items-center gap-2 pl-10 sm:pl-[3.75rem]">
          {showIncomingActions && (
            <>
              <RowAction intent="primary" onClick={onAccept}>Accept</RowAction>
              <RowAction intent="secondary" asLink href={`/?counter=${encodeURIComponent(proposal.id)}`}>
                Counter
              </RowAction>
              <RowAction intent="danger" onClick={onDecline}>Decline</RowAction>
            </>
          )}
          {showOutgoingActions && (
            <>
              <RowAction intent="secondary" asLink href={`/?edit=${encodeURIComponent(proposal.id)}`}>
                Edit
              </RowAction>
              <RowAction intent="secondary" onClick={onNudge}>Nudge</RowAction>
              <RowAction intent="danger" onClick={onCancel}>Cancel</RowAction>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Compact row button / link. Three visual intents — primary (accept,
 * positive action), secondary (edit/nudge/counter), danger (cancel,
 * decline). Matches the sizing used on the detail view's ActionBar
 * but tuned smaller since rows stack densely on mobile.
 */
function RowAction(
  props:
    | { intent: 'primary' | 'secondary' | 'danger'; onClick: () => void; children: React.ReactNode; asLink?: false; href?: never }
    | { intent: 'primary' | 'secondary' | 'danger'; asLink: true; href: string; children: React.ReactNode; onClick?: never },
) {
  const base = 'inline-flex items-center justify-center px-2.5 h-7 rounded-md text-[11px] font-bold transition-colors';
  const cls = props.intent === 'primary'
    ? `${base} bg-emerald-500/15 border border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/25 hover:border-emerald-400/70`
    : props.intent === 'danger'
      ? `${base} bg-red-500/10 border border-red-500/40 text-red-300 hover:bg-red-500/20 hover:border-red-400/60`
      : `${base} bg-space-800/60 border border-space-700 text-gray-300 hover:border-gold/40 hover:text-gold`;
  if ('asLink' in props && props.asLink) {
    return <a href={props.href} className={cls}>{props.children}</a>;
  }
  return <button type="button" onClick={props.onClick} className={cls}>{props.children}</button>;
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
