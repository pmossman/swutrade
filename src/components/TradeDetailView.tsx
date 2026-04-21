import { useMemo, useState } from 'react';
import { AppHeader, type BreadcrumbSegment } from './ui/AppHeader';
import { StatusBadge } from './ui/StatusBadge';
import { LoadingState, ErrorState } from './ui/states';
import { NudgeDialog } from './NudgeDialog';
import { useAuthContext } from '../contexts/AuthContext';
import {
  useTradeDetail,
  type CardSnapshot,
  type ProposalEvent,
  type TradeDetail,
  type UserStub,
} from '../hooks/useTradeDetail';

interface TradeDetailViewProps {
  tradeId: string;
}

/**
 * /?trade=<id> — single proposal detail page. Shows the full payload,
 * a status badge, chain-context links if this is part of a counter
 * chain, the activity timeline, and role-appropriate actions:
 *
 *   - Proposer + pending: Edit · Nudge · Cancel this proposal
 *   - Recipient + pending: Move forward (Accept as-is · Edit together)
 *                        + Push back (Counter offer · Decline)
 *   - Anyone + thread-delivered: Open thread in Discord
 *
 * Counter + Edit-together are deep-links to the web composer
 * (/?counter=<id>) or a shared session (/s/<code>); Accept + Decline
 * fire inline via the web endpoints, duplicating the Discord-bot
 * button surface for users who prefer the web.
 */
export function TradeDetailView({ tradeId }: TradeDetailViewProps) {
  const auth = useAuthContext();
  const { trade, status, cancel, cancelling, accept, decline, nudge, promoteToShared, mutating } = useTradeDetail(tradeId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nudgeOpen, setNudgeOpen] = useState(false);

  // Counterpart handle (if known) makes the final breadcrumb segment
  // richer than a generic "Proposal" label — easier to orient when the
  // user has several detail pages open or navigates back from a deep
  // link. Falls back to "Proposal" while the trade is still loading so
  // the header doesn't flicker between labels.
  const breadcrumbs = useMemo<BreadcrumbSegment[]>(() => {
    const base: BreadcrumbSegment[] = [
      { label: 'Home', href: '/' },
      { label: 'My trades', href: '/?trades=1' },
    ];
    if (status === 'ready' && trade) {
      const counterpart = trade.viewerIsProposer ? trade.recipient : trade.proposer;
      const handle = counterpart?.handle;
      base.push({ label: handle ? `@${handle}` : 'Proposal' });
    } else {
      base.push({ label: 'Proposal' });
    }
    return base;
  }, [status, trade]);

  const handleCancel = async () => {
    setActionError(null);
    const result = await cancel();
    if (!result.ok) {
      if (result.reason === 'already-resolved') {
        setActionError('This proposal was just resolved by the recipient — reload to see the new state.');
      } else {
        setActionError(result.detail ?? "Couldn't cancel. Try again in a moment.");
      }
    }
  };

  const handleAccept = async () => {
    setActionError(null);
    const result = await accept();
    if (!result.ok) {
      if (result.reason === 'already-resolved') {
        setActionError('This proposal was already resolved.');
      } else {
        setActionError(result.detail ?? "Couldn't accept. Try again in a moment.");
      }
    }
  };

  const handleDecline = async () => {
    setActionError(null);
    const result = await decline();
    if (!result.ok) {
      if (result.reason === 'already-resolved') {
        setActionError('This proposal was already resolved.');
      } else {
        setActionError(result.detail ?? "Couldn't decline. Try again in a moment.");
      }
    }
  };

  const handlePromoteToShared = async () => {
    setActionError(null);
    const result = await promoteToShared();
    if (result.ok) {
      // Full-page navigation — the shared canvas is a distinct view
      // and we want the URL + history entry to reflect the jump so
      // back-button semantics match user expectation.
      window.location.href = `/s/${encodeURIComponent(result.data.sessionId)}`;
      return;
    }
    if (result.reason === 'already-resolved') {
      setActionError('This proposal was already resolved.');
    } else if (result.reason === 'forbidden') {
      setActionError("You can't promote a proposal you sent — edit it instead.");
    } else {
      setActionError(result.detail ?? "Couldn't open a shared canvas. Try again in a moment.");
    }
  };

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <AppHeader auth={auth} breadcrumbs={breadcrumbs} />

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-2 max-w-3xl mx-auto w-full" data-testid="trade-detail">
        {status === 'loading' && <LoadingState className="mt-6" />}
        {status === 'not-found' && (
          <ErrorState className="mt-6">
            Trade not found — it may have been deleted or sent to someone else.
          </ErrorState>
        )}
        {status === 'error' && (
          <ErrorState className="mt-6">Couldn't load this trade. Try refreshing.</ErrorState>
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
              <StatusBadge status={trade.status} size="md" />
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

            {/* Imbalance — derived from card prices, serves as the implied
                cash settlement for the trade. Hidden when the two sides
                are close enough ($0.50) to be considered balanced. */}
            <ImbalanceStrip
              offering={trade.offeringCards}
              receiving={trade.receivingCards}
              viewerIsProposer={trade.viewerIsProposer}
            />

            <ActionBar
              trade={trade}
              onCancel={handleCancel}
              onAccept={handleAccept}
              onDecline={handleDecline}
              onPromoteToShared={handlePromoteToShared}
              onOpenNudge={() => setNudgeOpen(true)}
              mutating={mutating || cancelling}
              error={actionError}
            />

            {/* Open-thread deep link — only renders when the proposal
                went via a Discord private thread (recent proposals
                since TRADES_CHANNEL_ID was configured). Falls back to
                nothing when the proposal landed as a plain DM. */}
            {trade.discordThreadId && (
              <OpenInDiscordLink threadId={trade.discordThreadId} />
            )}

            {/* Activity timeline — oldest → newest. Empty for proposals
                that predate the event-log rollout, which is acceptable
                for the beta period (no backfill). */}
            {trade.events.length > 0 && (
              <ActivityTimeline events={trade.events} />
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

      {trade && (
        <NudgeDialog
          open={nudgeOpen}
          recipientHandle={trade.recipient?.handle ?? 'them'}
          onClose={() => setNudgeOpen(false)}
          onNudge={nudge}
        />
      )}
    </div>
  );
}

/**
 * Role-aware action cluster. Recipient sees two response groups
 * ("Move forward" — Accept as-is, Edit together / "Push back" —
 * Counter offer, Decline); proposer gets Edit/Nudge/Cancel. Closed
 * proposals render nothing — the status badge + timestamps tell the
 * story.
 */
function ActionBar({
  trade,
  onCancel,
  onAccept,
  onDecline,
  onPromoteToShared,
  onOpenNudge,
  mutating,
  error,
}: {
  trade: TradeDetail;
  onCancel: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onPromoteToShared: () => void;
  onOpenNudge: () => void;
  mutating: boolean;
  error: string | null;
}) {
  if (trade.status !== 'pending') return null;

  if (trade.viewerIsRecipient) {
    const proposerHandle = trade.proposer?.handle ?? 'them';
    // Two response groups, split to make the mental model obvious:
    //   (1) Move forward  — Accept (as-is) · Edit together (shared canvas)
    //   (2) Push back     — Counter · Decline
    // v1 shipped all four as a flat wrap-row with Edit together
    // appended last (UX-A3 in the audit) — reads as "Accept/Counter/
    // Decline are one thing and Edit-together is a tacked-on fourth
    // option". Grouping + ordering forces the question the user is
    // actually answering: "do I take this, or push back?" Colors keep
    // their audit-documented meaning (emerald=success, cyan=shared,
    // red=destructive, neutral=keep-negotiating).
    return (
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <div className="text-[10px] tracking-[0.18em] uppercase text-gray-500 font-bold">
            Move forward
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onAccept}
              disabled={mutating}
              data-testid="accept-proposal"
              className="flex-1 sm:flex-none px-4 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/50 text-emerald-200 text-sm font-bold hover:bg-emerald-500/25 hover:border-emerald-400/70 transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {mutating ? 'Working…' : 'Accept as-is'}
            </button>
            <button
              type="button"
              onClick={onPromoteToShared}
              disabled={mutating}
              data-testid="promote-to-shared"
              title={`Open a shared trade canvas with @${proposerHandle} so you can both edit`}
              className="flex-1 sm:flex-none inline-flex items-center justify-center px-4 h-9 rounded-lg bg-cyan-500/15 border border-cyan-500/50 text-cyan-200 text-sm font-bold hover:bg-cyan-500/25 hover:border-cyan-400/70 transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {mutating ? 'Working…' : 'Edit together'}
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[10px] tracking-[0.18em] uppercase text-gray-500 font-bold">
            Push back
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={`/?counter=${encodeURIComponent(trade.id)}`}
              className="flex-1 sm:flex-none inline-flex items-center justify-center px-4 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-sm font-medium text-gray-300 hover:text-gold transition-colors"
            >
              Counter offer
            </a>
            <button
              type="button"
              onClick={onDecline}
              disabled={mutating}
              data-testid="decline-proposal"
              className="flex-1 sm:flex-none px-4 h-9 rounded-lg bg-red-500/10 border border-red-500/40 text-red-300 text-sm font-bold hover:bg-red-500/20 hover:border-red-400/60 transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {mutating ? 'Working…' : 'Decline'}
            </button>
          </div>
        </div>
        {error && <div className="text-[11px] text-red-300">{error}</div>}
      </section>
    );
  }

  if (trade.viewerIsProposer) {
    return (
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <a
            href={`/?edit=${encodeURIComponent(trade.id)}`}
            className="inline-flex items-center justify-center px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-sm font-medium text-gray-300 hover:text-gold transition-colors"
          >
            Edit
          </a>
          <button
            type="button"
            onClick={onOpenNudge}
            className="inline-flex items-center justify-center px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-sm font-medium text-gray-300 hover:text-gold transition-colors"
          >
            Nudge
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={mutating}
            className="px-3 h-9 rounded-lg bg-red-500/10 border border-red-500/40 text-red-300 text-sm font-bold hover:bg-red-500/20 hover:border-red-400/60 transition-colors disabled:opacity-50 disabled:cursor-wait"
          >
            {mutating ? 'Cancelling…' : 'Cancel this proposal'}
          </button>
        </div>
        {error && <div className="text-[11px] text-red-300">{error}</div>}
      </section>
    );
  }

  return null;
}

/**
 * Open-in-Discord deep-link. Discord's `discord://discord.com/...`
 * URI jumps directly into the desktop client, while the https URL
 * falls back to the browser for users without the app installed.
 * Rendering just the https form — Discord auto-detects the desktop
 * app when you follow the link in the browser, so we don't need
 * both. Uses `rel="noopener"` to avoid window.opener leakage.
 */
function OpenInDiscordLink({ threadId }: { threadId: string }) {
  const url = `https://discord.com/channels/@me/${encodeURIComponent(threadId)}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 self-start px-3 h-8 rounded-lg bg-[#5865F2]/15 border border-[#5865F2]/40 hover:bg-[#5865F2]/25 hover:border-[#5865F2]/60 text-xs font-semibold text-[#a0a9ff] transition-colors"
    >
      <DiscordIcon className="w-3.5 h-3.5" />
      Open thread in Discord
    </a>
  );
}

function ActivityTimeline({ events }: { events: ProposalEvent[] }) {
  return (
    <section aria-labelledby="activity-timeline-heading">
      <h2
        id="activity-timeline-heading"
        className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold mb-2"
      >
        Activity
      </h2>
      <ul className="flex flex-col gap-0.5 rounded-lg border border-space-800 bg-space-800/30 divide-y divide-space-800 overflow-hidden">
        {events.map(e => (
          <TimelineRow key={e.id} event={e} />
        ))}
      </ul>
    </section>
  );
}

function TimelineRow({ event }: { event: ProposalEvent }) {
  const { label, actorText, tone } = describeEvent(event);
  const toneClass = tone === 'success'
    ? 'text-emerald-300'
    : tone === 'warn'
      ? 'text-amber-300'
      : tone === 'danger'
        ? 'text-red-300'
        : 'text-gray-300';
  const noteText = event.type === 'nudged' && typeof event.payload?.note === 'string' && event.payload.note
    ? `"${event.payload.note}"`
    : null;
  return (
    <li className="px-3 py-2 text-[11px] leading-snug">
      <div className="flex items-baseline justify-between gap-3">
        <span className={`font-medium ${toneClass}`}>
          {label}
          {actorText && <span className="text-gray-500 font-normal"> · {actorText}</span>}
        </span>
        <span className="text-gray-500 tabular-nums shrink-0">{timeAgo(event.createdAt)}</span>
      </div>
      {noteText && (
        <div className="mt-0.5 text-gray-400 italic truncate">{noteText}</div>
      )}
    </li>
  );
}

function describeEvent(event: ProposalEvent): {
  label: string;
  actorText: string | null;
  tone: 'success' | 'warn' | 'danger' | 'neutral';
} {
  const actor = event.actor?.handle ? `@${event.actor.handle}` : null;
  switch (event.type) {
    case 'created':
      return { label: 'Proposal sent', actorText: actor, tone: 'neutral' };
    case 'delivered_ok':
      return { label: 'Delivered', actorText: null, tone: 'success' };
    case 'delivered_failed':
      return { label: 'Delivery failed', actorText: null, tone: 'danger' };
    case 'edited':
      return { label: 'Proposer edited', actorText: actor, tone: 'warn' };
    case 'nudged':
      return { label: 'Nudged', actorText: actor, tone: 'warn' };
    case 'accepted':
      return { label: 'Accepted', actorText: actor, tone: 'success' };
    case 'declined':
      return { label: 'Declined', actorText: actor, tone: 'danger' };
    case 'cancelled':
      return { label: 'Cancelled', actorText: actor, tone: 'danger' };
    case 'countered':
      return { label: 'Countered', actorText: actor, tone: 'warn' };
    case 'expired':
      return { label: 'Expired', actorText: null, tone: 'neutral' };
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Shows the implied cash settlement between the two sides. The number
 * is derived from card-price subtotals so it stays in sync whenever
 * prices or snapshots change — no separate cash state is persisted.
 * See ROADMAP / NEXT.md for the "cash = imbalance" decision rationale.
 */
function ImbalanceStrip({
  offering,
  receiving,
  viewerIsProposer,
}: {
  offering: CardSnapshot[];
  receiving: CardSnapshot[];
  viewerIsProposer: boolean;
}) {
  const offTotal = offering.reduce((s, c) => s + (c.unitPrice ?? 0) * c.qty, 0);
  const recTotal = receiving.reduce((s, c) => s + (c.unitPrice ?? 0) * c.qty, 0);
  const diff = offTotal - recTotal;
  // "Balanced" case: hide rather than show "$0 imbalance" noise.
  if (Math.abs(diff) < 0.5) return null;

  // `diff > 0` → the offering side is higher-value → the offerer
  // (proposer) typically receives the residual in cash. Whose label
  // reads as "you" depends on the viewer's role.
  const offeringIsViewer = viewerIsProposer;
  const offeringHasMore = diff > 0;
  const receiverOfCash = offeringHasMore === offeringIsViewer ? 'you' : 'them';
  return (
    <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
      <span className="font-bold">${Math.abs(diff).toFixed(2)}</span>{' '}
      imbalance — typically settled in cash from{' '}
      <strong>{receiverOfCash === 'you' ? 'them' : 'you'}</strong> to{' '}
      <strong>{receiverOfCash}</strong>.
    </section>
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

function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.548-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.182 0-2.157-1.086-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.332-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.332-.946 2.418-2.157 2.418z"/>
    </svg>
  );
}
