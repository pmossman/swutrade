import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';
import { NavBar } from '../components/primitives/NavBar';
import { ActionBar } from '../components/primitives/ActionBar';
import { Chip } from '../components/primitives/Chip';
import { TradeSide } from '../components/TradeSide';
import { BalanceStrip } from '../components/BalanceStrip';
import { CardPicker } from '../components/CardPicker';
import { PriceSheet } from '../components/PriceSheet';
import { InviteSheet } from '../components/InviteSheet';
import { useAuth } from '../hooks/useAuth';
import { useSession } from '../hooks/useSession';
import type { TradeCardSnapshot } from '../lib/trade';
import { totalOf } from '../lib/trade';
import type { SetCard } from '../lib/cards';

/*
 * Design §4.3 Trade canvas. One surface handles every state — solo,
 * open slot, shared, awaiting, settled, cancelled, expired. 1d ships
 * solo + open-slot + terminal-readonly. Shared (both editing) + async
 * pitched states land in 1e and 1f.
 */

export function TradeCanvasRoute() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const trade = useSession(code);
  const auth = useAuth();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [priceSheetOpen, setPriceSheetOpen] = useState(false);
  const [inviteSheetOpen, setInviteSheetOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (trade.status === 'pending') {
    return (
      <Screen withTabBar={false}>
        <NavBar title="Trade" back="/" />
        <p className="px-4 py-8 text-center text-[length:var(--text-meta)] text-fg-muted">
          Loading trade…
        </p>
      </Screen>
    );
  }

  if (trade.status === 'not-found' || trade.status === 'error') {
    return (
      <Screen withTabBar={false}>
        <NavBar title="Trade" back="/" />
        <EmptyState
          title="Trade not found"
          body="This trade doesn't exist or has been cancelled, settled, or expired."
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

  if (trade.status === 'preview') {
    return (
      <Screen withTabBar={false}>
        <NavBar title="Trade" back="/" />
        <EmptyState
          title={`@${trade.preview?.creator.handle} invited you`}
          body={`They're offering ${trade.preview?.creatorCardCount ?? 0} card${
            trade.preview?.creatorCardCount === 1 ? '' : 's'
          }. Join to see details and add your side.`}
          action={
            <button
              type="button"
              onClick={() => void trade.claim()}
              disabled={trade.isMutating}
              className="h-11 rounded-xl bg-accent px-6 font-semibold text-accent-fg disabled:opacity-60"
            >
              {trade.isMutating ? 'Joining…' : 'Join this trade'}
            </button>
          }
        />
      </Screen>
    );
  }

  const session = trade.session!;
  const isTerminal = session.status !== 'active';
  const yourTotal = totalOf(session.yourCards);
  const theirTotal = totalOf(session.theirCards);

  async function handleChangeYourQty(productId: string, qty: number) {
    const next =
      qty <= 0
        ? session.yourCards.filter((c) => c.productId !== productId)
        : session.yourCards.map((c) =>
            c.productId === productId ? { ...c, qty: Math.min(99, qty) } : c,
          );
    await trade.saveCards(next);
  }

  async function handleAddFromPicker(card: SetCard) {
    const existing = session.yourCards.find((c) => c.productId === card.productId);
    let next: TradeCardSnapshot[];
    if (existing) {
      next = session.yourCards.map((c) =>
        c.productId === card.productId ? { ...c, qty: Math.min(99, c.qty + 1) } : c,
      );
    } else {
      next = [
        ...session.yourCards,
        {
          productId: card.productId,
          name: card.name,
          variant: card.variant,
          qty: 1,
          unitPrice: card.marketPrice,
        },
      ];
    }
    await trade.saveCards(next);
    setPickerOpen(false);
  }

  async function handleShare() {
    const url = new URL(window.location.href).toString();
    try {
      if (navigator.share) {
        await navigator.share({ url, title: 'SWUTrade' });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* user cancelled share dialog — no-op */
    }
  }

  const stateChip = (() => {
    if (session.status === 'settled') return <Chip tone="settled">Settled</Chip>;
    if (session.status === 'cancelled') return <Chip tone="declined">Cancelled</Chip>;
    if (session.status === 'expired') return <Chip tone="neutral">Expired</Chip>;
    if (session.openSlot) return <Chip tone="shared">Waiting for partner</Chip>;
    return <Chip tone="shared">Live</Chip>;
  })();

  return (
    <Screen withTabBar={false}>
      <NavBar
        title={
          session.counterpart ? `@${session.counterpart.handle}` : 'Trade'
        }
        back="/"
        trailing={
          <button
            type="button"
            onClick={handleShare}
            aria-label="Share trade"
            className="grid size-11 place-items-center rounded-full text-fg hover:bg-border/30"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13V3" />
              <path d="M6 7l4-4 4 4" />
              <path d="M4 13v2a2 2 0 002 2h8a2 2 0 002-2v-2" />
            </svg>
          </button>
        }
      />

      <div className="flex flex-col gap-4 px-4 pt-3 pb-36">
        <div className="flex items-center justify-between">
          {stateChip}
          {copied ? (
            <span className="text-[length:var(--text-meta)] text-state-settled">
              Link copied
            </span>
          ) : null}
        </div>

        <TradeSide
          side="yours"
          cards={session.yourCards}
          total={yourTotal}
          editable={!isTerminal}
          onChangeQty={handleChangeYourQty}
          onAdd={() => setPickerOpen(true)}
        />

        <BalanceStrip
          yourCards={session.yourCards}
          theirCards={session.theirCards}
          yourTotal={yourTotal}
          theirTotal={theirTotal}
          onOpenPricing={() => setPriceSheetOpen(true)}
        />

        <TradeSide
          side="theirs"
          cards={session.theirCards}
          total={theirTotal}
          editable={false}
          emptyLabel={
            session.openSlot
              ? 'Share this trade or invite someone by handle'
              : session.counterpart
                ? `Waiting on @${session.counterpart.handle} to add cards`
                : 'Waiting on your partner'
          }
        />
      </div>

      {!isTerminal ? (
        <ActionBar
          primary={
            session.openSlot ? (
              <button
                type="button"
                onClick={() => setInviteSheetOpen(true)}
                className="h-11 w-full rounded-xl bg-accent font-semibold text-accent-fg"
              >
                Invite someone
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void trade.confirm()}
                disabled={
                  trade.isMutating ||
                  session.yourCards.length + session.theirCards.length === 0 ||
                  session.confirmedByViewer
                }
                className="h-11 w-full rounded-xl bg-accent font-semibold text-accent-fg disabled:opacity-60"
              >
                {session.confirmedByViewer
                  ? `Waiting on @${session.counterpart?.handle ?? 'partner'}`
                  : 'Confirm trade'}
              </button>
            )
          }
          secondary={
            !session.openSlot ? (
              <button
                type="button"
                onClick={() => void trade.cancel()}
                disabled={trade.isMutating}
                className="h-11 rounded-xl border border-border bg-surface px-4 font-semibold text-danger hover:bg-danger/10 disabled:opacity-60"
              >
                Cancel
              </button>
            ) : null
          }
        />
      ) : null}

      <CardPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="Add to your side"
        onPick={handleAddFromPicker}
      />

      <PriceSheet
        open={priceSheetOpen}
        onOpenChange={setPriceSheetOpen}
        yourCards={session.yourCards}
        theirCards={session.theirCards}
        yourTotal={yourTotal}
        theirTotal={theirTotal}
      />

      {code ? (
        <InviteSheet
          open={inviteSheetOpen}
          onOpenChange={setInviteSheetOpen}
          sessionId={code}
          canInviteByHandle={!!auth.user && !auth.user.isAnonymous}
        />
      ) : null}
    </Screen>
  );
}
