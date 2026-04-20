import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Screen } from '../components/primitives/Screen';
import { NavBar } from '../components/primitives/NavBar';
import { ActionBar } from '../components/primitives/ActionBar';
import { Chip } from '../components/primitives/Chip';
import { EmptyState } from '../components/primitives/EmptyState';
import { TradeSide } from '../components/TradeSide';
import { BalanceStrip } from '../components/BalanceStrip';
import { CardPicker } from '../components/CardPicker';
import { PriceSheet } from '../components/PriceSheet';
import { useAuth } from '../hooks/useAuth';
import { usePropose } from '../hooks/usePropose';
import { totalOf } from '../lib/trade';
import type { TradeCardSnapshot } from '../lib/trade';
import type { SetCard } from '../lib/cards';

/*
 * Async-pitch composer. URL: /compose?to=<handle>. Client-only draft
 * state (no server round-trip) until Send. Both sides are editable
 * because the user builds the offer AND the ask locally — unlike a
 * live session where each party edits only their own half.
 *
 * Send POSTs /api/trades/propose; on success we navigate to the
 * returned /t/:id trade detail. Error paths surface inline.
 */
export function ComposeRoute() {
  const navigate = useNavigate();
  const auth = useAuth();
  const [params] = useSearchParams();
  const recipientHandle = params.get('to')?.replace(/^@/, '') ?? '';

  const [yourCards, setYourCards] = useState<TradeCardSnapshot[]>([]);
  const [theirCards, setTheirCards] = useState<TradeCardSnapshot[]>([]);
  const [message, setMessage] = useState('');
  const [pickerTarget, setPickerTarget] = useState<null | 'yours' | 'theirs'>(null);
  const [priceSheetOpen, setPriceSheetOpen] = useState(false);
  const propose = usePropose();

  if (auth.user?.isAnonymous || (!auth.user && !auth.isLoading)) {
    return (
      <Screen withTabBar={false}>
        <NavBar title="Pitch a trade" back="/" />
        <EmptyState
          title="Sign in to pitch a trade"
          body="Async pitches need a Discord account so we can deliver them to the other side."
          action={
            <button
              type="button"
              onClick={auth.login}
              className="h-11 rounded-xl bg-accent px-6 font-semibold text-accent-fg"
            >
              Continue with Discord
            </button>
          }
        />
      </Screen>
    );
  }

  if (!recipientHandle) {
    return (
      <Screen withTabBar={false}>
        <NavBar title="Pitch a trade" back="/" />
        <EmptyState
          title="No recipient"
          body="Open this screen from a profile's Trade-with button so we know who you're pitching."
        />
      </Screen>
    );
  }

  const yourTotal = totalOf(yourCards);
  const theirTotal = totalOf(theirCards);

  function handleChangeYourQty(productId: string, qty: number) {
    if (qty <= 0) {
      setYourCards((xs) => xs.filter((c) => c.productId !== productId));
      return;
    }
    setYourCards((xs) =>
      xs.map((c) => (c.productId === productId ? { ...c, qty: Math.min(99, qty) } : c)),
    );
  }

  function handleChangeTheirQty(productId: string, qty: number) {
    if (qty <= 0) {
      setTheirCards((xs) => xs.filter((c) => c.productId !== productId));
      return;
    }
    setTheirCards((xs) =>
      xs.map((c) => (c.productId === productId ? { ...c, qty: Math.min(99, qty) } : c)),
    );
  }

  function handlePick(card: SetCard) {
    const snap: TradeCardSnapshot = {
      productId: card.productId,
      name: card.name,
      variant: card.variant,
      qty: 1,
      unitPrice: card.marketPrice,
    };
    if (pickerTarget === 'yours') {
      setYourCards((xs) => {
        const existing = xs.find((c) => c.productId === card.productId);
        if (existing) {
          return xs.map((c) =>
            c.productId === card.productId ? { ...c, qty: Math.min(99, c.qty + 1) } : c,
          );
        }
        return [...xs, snap];
      });
    } else if (pickerTarget === 'theirs') {
      setTheirCards((xs) => {
        const existing = xs.find((c) => c.productId === card.productId);
        if (existing) {
          return xs.map((c) =>
            c.productId === card.productId ? { ...c, qty: Math.min(99, c.qty + 1) } : c,
          );
        }
        return [...xs, snap];
      });
    }
    setPickerTarget(null);
  }

  async function handleSend() {
    if (yourCards.length === 0 && theirCards.length === 0) return;
    try {
      const res = await propose.mutateAsync({
        recipientHandle,
        offeringCards: yourCards,
        receivingCards: theirCards,
        message: message.trim() || undefined,
      });
      navigate(`/t/${res.id}`);
    } catch {
      /* surfaced inline below via propose.error */
    }
  }

  const canSend = yourCards.length + theirCards.length > 0 && !propose.isPending;

  return (
    <Screen withTabBar={false}>
      <NavBar title={`Pitch to @${recipientHandle}`} back="/" />

      <div className="flex flex-col gap-4 px-4 pt-3 pb-36">
        <Chip tone="attention">Pitching · @{recipientHandle}</Chip>

        <TradeSide
          side="yours"
          cards={yourCards}
          total={yourTotal}
          editable
          onChangeQty={handleChangeYourQty}
          onAdd={() => setPickerTarget('yours')}
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
          editable
          onChangeQty={handleChangeTheirQty}
          onAdd={() => setPickerTarget('theirs')}
          emptyLabel="What do you want from them?"
        />

        <div className="flex flex-col gap-2">
          <label
            htmlFor="pitch-note"
            className="text-[length:var(--text-meta)] font-semibold uppercase tracking-wide text-fg-muted"
          >
            Message (optional)
          </label>
          <textarea
            id="pitch-note"
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, 500))}
            placeholder="Hey — swap these at SacLGS tonight?"
            className="min-h-[88px] rounded-xl border border-border bg-surface px-3 py-2 text-[length:var(--text-body)] text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
        </div>

        {propose.error ? (
          <p role="alert" className="text-[length:var(--text-meta)] text-danger">
            {propose.error.reason === 'not-found'
              ? `No SWUTrade user with the handle @${recipientHandle}`
              : propose.error.reason === 'forbidden'
                ? `You can't pitch to @${recipientHandle}`
                : `Couldn't send the pitch. Try again.`}
          </p>
        ) : null}
      </div>

      <ActionBar
        primary={
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="h-11 w-full rounded-xl bg-accent font-semibold text-accent-fg disabled:opacity-60"
          >
            {propose.isPending ? 'Sending…' : 'Send pitch'}
          </button>
        }
      />

      <CardPicker
        open={pickerTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPickerTarget(null);
        }}
        title={pickerTarget === 'yours' ? 'Add to your side' : 'Add to their side'}
        onPick={handlePick}
      />

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
