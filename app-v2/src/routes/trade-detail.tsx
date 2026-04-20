import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Screen } from '../components/primitives/Screen';
import { NavBar } from '../components/primitives/NavBar';
import { EmptyState } from '../components/primitives/EmptyState';
import { ActionBar } from '../components/primitives/ActionBar';
import { Chip, type ChipTone } from '../components/primitives/Chip';
import { TradeSide } from '../components/TradeSide';
import { BalanceStrip } from '../components/BalanceStrip';
import { PriceSheet } from '../components/PriceSheet';
import { useProposal, type ProposalStatus } from '../hooks/useProposal';
import { totalOf } from '../lib/trade';

/*
 * Design §4.10 — inbound trade detail is not a separate screen from
 * the canvas, but an "Awaiting" state rendering. Reuses TradeSide +
 * BalanceStrip; primary action is Accept for the recipient, Cancel
 * for the proposer.
 *
 * URL: /t/:id. /?trade=<id> (v1's legacy shape) is NOT supported in
 * v2 — external links carry /t/:id from Discord DMs Phase 2 onward.
 */

const STATE_TONE: Record<ProposalStatus, ChipTone> = {
  pending: 'attention',
  accepted: 'settled',
  declined: 'declined',
  cancelled: 'declined',
  expired: 'neutral',
  countered: 'countered',
};

const STATE_LABEL: Record<ProposalStatus, string> = {
  pending: 'Pending response',
  accepted: 'Accepted',
  declined: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
  countered: 'Countered',
};

export function TradeDetailRoute() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const trade = useProposal(id);
  const [priceSheetOpen, setPriceSheetOpen] = useState(false);

  if (trade.status === 'pending') {
    return (
      <Screen withTabBar={false}>
        <NavBar title="Trade" back="/" />
        <p className="px-4 py-8 text-center text-fg-muted">Loading trade…</p>
      </Screen>
    );
  }

  if (trade.status === 'error' || !trade.proposal) {
    return (
      <Screen withTabBar={false}>
        <NavBar title="Trade" back="/" />
        <EmptyState
          title="Trade not found"
          body="This pitch doesn't exist, has expired, or was sent to someone else."
          action={
            <button
              type="button"
              onClick={() => navigate('/')}
              className="h-11 rounded-xl bg-accent px-6 font-semibold text-accent-fg"
            >
              Back to Trades
            </button>
          }
        />
      </Screen>
    );
  }

  const p = trade.proposal;

  // Flip "offering" / "receiving" based on viewer role so
  // "You offer" always means "what you give up" regardless of who
  // originated the pitch.
  const yourCards = p.viewerIsProposer ? p.offeringCards : p.receivingCards;
  const theirCards = p.viewerIsProposer ? p.receivingCards : p.offeringCards;
  const yourTotal = totalOf(yourCards);
  const theirTotal = totalOf(theirCards);
  const counterpart = p.viewerIsProposer ? p.recipient : p.proposer;

  const isPending = p.status === 'pending';

  return (
    <Screen withTabBar={false}>
      <NavBar
        title={counterpart ? `@${counterpart.handle}` : 'Trade'}
        back="/"
      />

      <div className="flex flex-col gap-4 px-4 pt-3 pb-36">
        <div className="flex items-center justify-between">
          <Chip tone={STATE_TONE[p.status]}>{STATE_LABEL[p.status]}</Chip>
          {p.viewerIsRecipient && isPending ? (
            <span className="text-[length:var(--text-meta)] text-fg-muted">
              @{counterpart?.handle} pitched this
            </span>
          ) : null}
        </div>

        <TradeSide
          side="yours"
          cards={yourCards}
          total={yourTotal}
          editable={false}
        />

        <BalanceStrip
          yourCards={yourCards}
          theirCards={theirCards}
          yourTotal={yourTotal}
          theirTotal={theirTotal}
          onOpenPricing={() => setPriceSheetOpen(true)}
        />

        <TradeSide
          side="theirs"
          cards={theirCards}
          total={theirTotal}
          editable={false}
        />

        {p.message ? (
          <blockquote className="rounded-2xl border border-border bg-surface p-4">
            <p className="whitespace-pre-wrap text-[length:var(--text-body)] text-fg">
              {p.message}
            </p>
            <footer className="mt-2 text-[length:var(--text-meta)] text-fg-muted">
              — @{counterpart?.handle}
            </footer>
          </blockquote>
        ) : null}
      </div>

      {isPending && p.viewerIsRecipient ? (
        <ActionBar
          primary={
            <button
              type="button"
              onClick={() => void trade.accept()}
              disabled={trade.isMutating}
              className="h-11 w-full rounded-xl bg-accent font-semibold text-accent-fg disabled:opacity-60"
            >
              {trade.isMutating ? 'Working…' : 'Accept'}
            </button>
          }
          secondary={
            <button
              type="button"
              onClick={() => void trade.decline()}
              disabled={trade.isMutating}
              className="h-11 rounded-xl border border-border bg-surface px-4 font-semibold text-danger hover:bg-danger/10 disabled:opacity-60"
            >
              Decline
            </button>
          }
        />
      ) : null}

      {isPending && p.viewerIsProposer ? (
        <ActionBar
          primary={
            <button
              type="button"
              disabled
              className="h-11 w-full rounded-xl border border-border bg-surface font-semibold text-fg-muted"
            >
              Waiting on @{counterpart?.handle}
            </button>
          }
          secondary={
            <button
              type="button"
              onClick={() => void trade.cancel()}
              disabled={trade.isMutating}
              className="h-11 rounded-xl border border-border bg-surface px-4 font-semibold text-danger hover:bg-danger/10 disabled:opacity-60"
            >
              Cancel
            </button>
          }
        />
      ) : null}

      <PriceSheet
        open={priceSheetOpen}
        onOpenChange={setPriceSheetOpen}
        yourCards={yourCards}
        theirCards={theirCards}
        yourTotal={yourTotal}
        theirTotal={theirTotal}
      />
    </Screen>
  );
}
