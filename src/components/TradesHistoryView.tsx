import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppHeader } from './ui/AppHeader';
import { StatusBadge } from './ui/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from './ui/states';
import { NudgeDialog } from './NudgeDialog';
import { useAuthContext } from '../contexts/AuthContext';
import { useTradesList, type TradeListEntry } from '../hooks/useTradesList';
import type { UserStub } from '../hooks/useTradeDetail';
import {
  acceptProposal,
  bulkResolveProposals,
  cancelProposal,
  declineProposal,
  nudgeProposal,
  type ActionResult,
} from '../services/tradeActions';

type Tab = 'incoming' | 'outgoing' | 'history';

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
// Cap enforced on the server too — keep the UI matching so we don't
// ship a "select all 200" action that gets rejected by the API.
const BULK_RESOLVE_CAP = 50;

export function TradesHistoryView() {
  const auth = useAuthContext();
  const { proposals, status, refresh } = useTradesList();
  const [tab, setTab] = useState<Tab | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [nudgeTarget, setNudgeTarget] = useState<TradeListEntry | null>(null);
  // Selection is per-session and tab-local. Switching tabs clears it —
  // a user on Incoming who's selected 5 rows shouldn't accidentally
  // carry that selection over to Outgoing and fire the wrong bulk action.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkState, setBulkState] = useState<'idle' | 'running'>('idle');

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

  // Clear selection when switching tabs or when the underlying list
  // changes shape (e.g. a refresh dropped a resolved proposal).
  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const stillValid = new Set<string>();
      for (const id of prev) {
        if (activeList.some(p => p.id === id)) stillValid.add(id);
      }
      return stillValid.size === prev.size ? prev : stillValid;
    });
  }, [activeTab, activeList]);

  const bulkable = activeTab === 'incoming' || activeTab === 'outgoing';
  const bulkAction: 'decline' | 'cancel' = activeTab === 'incoming' ? 'decline' : 'cancel';

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size >= BULK_RESOLVE_CAP) {
        // Silent-cap — the user probably doesn't need more than 50 at
        // a time, and the bulk action bar already shows how many are
        // selected so they can see when the cap bites.
        return prev;
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      const allIds = activeList.slice(0, BULK_RESOLVE_CAP).map(p => p.id);
      // If every visible row (up to cap) is already selected, clear.
      // Otherwise select up to the cap.
      const everyVisibleSelected = allIds.length > 0 && allIds.every(id => prev.has(id));
      if (everyVisibleSelected) return new Set();
      return new Set(allIds);
    });
  }, [activeList]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleBulkResolve = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setBulkState('running');
    setRowError(null);
    const ids = Array.from(selectedIds);
    const result = await bulkResolveProposals(ids, bulkAction);
    setBulkState('idle');
    if (!result.ok) {
      setRowError(result.detail ?? `Couldn't ${bulkAction} those proposals. Try again.`);
      return;
    }
    const notOk = result.data.results.filter(r => r.outcome !== 'ok').length;
    if (notOk > 0) {
      setRowError(`${result.data.okCount} ${bulkAction}d · ${notOk} skipped (already resolved or no longer accessible).`);
    }
    setSelectedIds(new Set());
    await refresh();
  }, [selectedIds, bulkAction, refresh]);

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
      <AppHeader
        auth={auth}
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'My trades' },
        ]}
      />

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
          <>
            {bulkable && (
              <SelectAllBar
                visibleCount={Math.min(activeList.length, BULK_RESOLVE_CAP)}
                totalCount={activeList.length}
                selectedCount={selectedIds.size}
                onToggle={toggleSelectAll}
              />
            )}
            <ul className="flex flex-col gap-2 mt-3">
              {activeList.map(p => (
                <li key={p.id}>
                  <TradeRow
                    proposal={p}
                    tab={activeTab}
                    selectable={bulkable && p.status === 'pending'}
                    selected={selectedIds.has(p.id)}
                    onToggleSelected={() => toggleSelected(p.id)}
                    onCancel={() => handleRowAction('cancel', p)}
                    onAccept={() => handleRowAction('accept', p)}
                    onDecline={() => handleRowAction('decline', p)}
                    onNudge={() => setNudgeTarget(p)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </main>

      {selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          action={bulkAction}
          busy={bulkState === 'running'}
          onConfirm={handleBulkResolve}
          onClear={clearSelection}
        />
      )}

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
  selectable,
  selected,
  onToggleSelected,
  onCancel,
  onAccept,
  onDecline,
  onNudge,
}: {
  proposal: TradeListEntry;
  tab: Tab;
  selectable: boolean;
  selected: boolean;
  onToggleSelected: () => void;
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
    <div className={`flex flex-col gap-2 p-3 rounded-lg border transition-colors ${
      selected
        ? 'border-gold/60 bg-gold/10'
        : 'border-space-700 bg-space-800/40 hover:border-gold/30 hover:bg-space-800'
    }`}>
      <div className="flex items-center gap-3 min-w-0">
        {selectable && (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={selected ? 'Deselect this proposal' : 'Select this proposal for bulk actions'}
            onClick={onToggleSelected}
            className={`shrink-0 w-5 h-5 rounded border flex items-center justify-center transition-colors ${
              selected
                ? 'bg-gold border-gold text-space-900'
                : 'border-space-600 hover:border-gold/60 text-transparent'
            }`}
          >
            <CheckIcon className="w-3.5 h-3.5" />
          </button>
        )}
        <a
          href={`/?trade=${encodeURIComponent(proposal.id)}`}
          className="flex items-center gap-3 min-w-0 flex-1"
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
      </div>

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

/**
 * Compact select-all toggle above the row list. Shows the current
 * selection count vs. what's visible, plus a "(N more — cap is 50)"
 * hint when the list exceeds the bulk cap so users don't wonder why
 * the last rows won't check.
 */
function SelectAllBar({
  visibleCount,
  totalCount,
  selectedCount,
  onToggle,
}: {
  visibleCount: number;
  totalCount: number;
  selectedCount: number;
  onToggle: () => void;
}) {
  const allSelected = selectedCount >= visibleCount && visibleCount > 0;
  const overCap = totalCount > visibleCount;
  return (
    <div className="flex items-center gap-3 mt-3 text-[11px] text-gray-500">
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-space-800 hover:text-gray-300 transition-colors"
      >
        <span className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
          allSelected
            ? 'bg-gold border-gold text-space-900'
            : 'border-space-600'
        }`}>
          <CheckIcon className="w-3 h-3" />
        </span>
        <span>{allSelected ? 'Deselect all' : 'Select all'}</span>
      </button>
      {overCap && (
        <span>
          Showing {visibleCount} of {totalCount} · bulk cap is {visibleCount}
        </span>
      )}
    </div>
  );
}

/**
 * Sticky bottom bar summarising the bulk-selection state. Appears on
 * top of the row list, not in flow, so it doesn't shove content as
 * the user selects. Destructive confirmation is inline — tap the
 * button twice within a short window to fire. That matches how the
 * existing per-row Cancel/Decline works (no modal) while still
 * giving the user a beat to realise they just tapped "Decline 23".
 */
function BulkActionBar({
  count,
  action,
  busy,
  onConfirm,
  onClear,
}: {
  count: number;
  action: 'decline' | 'cancel';
  busy: boolean;
  onConfirm: () => void;
  onClear: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  // Reset the armed state whenever the selection changes — catching a
  // half-armed state across count changes would be a foot-gun.
  useEffect(() => { setArmed(false); }, [count]);

  const verb = action === 'decline' ? 'Decline' : 'Cancel';
  const mainLabel = busy
    ? 'Working…'
    : armed
      ? `Tap to confirm — ${verb.toLowerCase()} ${count}`
      : `${verb} ${count}`;

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 border-t border-space-700 bg-space-900/95 backdrop-blur px-3 sm:px-6 py-3">
      <div className="max-w-3xl mx-auto flex items-center gap-3">
        <span className="text-xs text-gray-300 flex-1 min-w-0">
          <strong className="text-gold">{count}</strong> selected
        </span>
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-medium text-gray-300 hover:text-gold transition-colors disabled:opacity-50"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => {
            if (busy) return;
            if (!armed) { setArmed(true); return; }
            onConfirm();
          }}
          disabled={busy}
          className={`px-4 h-9 rounded-lg border text-xs font-bold transition-colors disabled:opacity-60 disabled:cursor-wait ${
            armed
              ? 'bg-red-500/30 border-red-400/70 text-red-100 hover:bg-red-500/40'
              : 'bg-red-500/10 border-red-500/40 text-red-300 hover:bg-red-500/20 hover:border-red-400/60'
          }`}
        >
          {mainLabel}
        </button>
      </div>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8l3 3 7-7" />
    </svg>
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
