import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';
import { FAB } from '../components/primitives/FAB';
import { Chip, type ChipTone } from '../components/primitives/Chip';
import { useAuth } from '../hooks/useAuth';
import { useCreateOpenSession } from '../hooks/useCreateOpenSession';
import { useMyTrades, type TradeRow, type TradeRowState } from '../hooks/useMyTrades';

const STATE_TONE: Record<TradeRowState, ChipTone> = {
  shared: 'shared',
  'shared-waiting': 'shared',
  pitched: 'neutral',
  awaiting: 'attention',
  settled: 'settled',
  declined: 'declined',
  cancelled: 'declined',
  expired: 'neutral',
  countered: 'countered',
};

const STATE_LABEL: Record<TradeRowState, string> = {
  shared: 'Live',
  'shared-waiting': 'Waiting for partner',
  pitched: 'Pitched',
  awaiting: 'Respond',
  settled: 'Settled',
  declined: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
  countered: 'Countered',
};

export function TradesRoute() {
  const auth = useAuth();
  const navigate = useNavigate();
  const createOpen = useCreateOpenSession();
  const trades = useMyTrades();
  const [errorOpen, setErrorOpen] = useState(false);

  async function startTrade() {
    setErrorOpen(false);
    try {
      const res = await createOpen.mutateAsync();
      navigate(`/s/${res.id}`);
    } catch {
      setErrorOpen(true);
    }
  }

  return (
    <Screen title="Trades">
      {errorOpen ? (
        <div
          role="alert"
          className="mb-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3"
        >
          <p className="text-[length:var(--text-body)] font-semibold text-danger">
            Couldn't start a trade.
          </p>
          <p className="mt-1 text-[length:var(--text-meta)] text-fg-muted">
            Check your connection and try again. Your cards aren't lost.
          </p>
          <button
            type="button"
            onClick={startTrade}
            disabled={createOpen.isPending}
            className="mt-3 h-11 rounded-xl bg-accent px-4 font-semibold text-accent-fg disabled:opacity-60"
          >
            {createOpen.isPending ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : null}

      {trades.needsResponse.length > 0 ? (
        <div className="mb-3 rounded-2xl border border-state-attention/40 bg-state-attention/8 px-4 py-3">
          <p className="text-[length:var(--text-body)] font-semibold">
            {trades.needsResponse.length === 1
              ? '1 trade needs your response'
              : `${trades.needsResponse.length} trades need your response`}
          </p>
        </div>
      ) : null}

      <TradesListBody trades={trades} isSignedIn={!!auth.user} />

      <FAB ariaLabel="Start trade" onClick={startTrade} />
    </Screen>
  );
}

function TradesListBody({
  trades,
  isSignedIn,
}: {
  trades: ReturnType<typeof useMyTrades>;
  isSignedIn: boolean;
}) {
  if (!isSignedIn) {
    return (
      <EmptyState
        title="Build a trade"
        body="Tap + to solo-build a trade and share the link. Sign in to pitch trades to other Discord users and keep a history."
      />
    );
  }

  if (trades.status === 'pending') {
    return (
      <p className="px-1 py-6 text-center text-[length:var(--text-meta)] text-fg-muted">
        Loading your trades…
      </p>
    );
  }

  if (trades.status === 'error') {
    return (
      <p className="px-1 py-6 text-center text-[length:var(--text-meta)] text-danger">
        Couldn't load your trades. Refresh and try again.
      </p>
    );
  }

  if (trades.rows.length === 0) {
    return (
      <EmptyState
        title="You haven't traded yet"
        body="Tap + to start a trade at a game store, pitch one async, or build a balance solo."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {trades.rows.map((row) => (
        <li key={`${row.kind}:${row.id}`}>
          <TradeListRow row={row} />
        </li>
      ))}
    </ul>
  );
}

function TradeListRow({ row }: { row: TradeRow }) {
  return (
    <Link
      to={row.href}
      className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-3 transition-colors hover:bg-border/30 active:bg-border/50"
    >
      {row.counterpartAvatarUrl ? (
        <img
          src={row.counterpartAvatarUrl}
          alt=""
          className="size-10 shrink-0 rounded-full"
          width={40}
          height={40}
        />
      ) : (
        <div
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-full bg-accent/15 text-accent"
        >
          {(row.counterpartHandle?.[0] ?? '?').toUpperCase()}
        </div>
      )}

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-semibold">
            {row.counterpartHandle ? `@${row.counterpartHandle}` : 'Solo trade'}
          </span>
          <Chip tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Chip>
        </span>
        <span className="mt-0.5 block truncate text-[length:var(--text-meta)] text-fg-muted">
          {row.topCardName
            ? `${row.topCardName} · ${row.offeringCount} ⇆ ${row.receivingCount}`
            : `${row.offeringCount} ⇆ ${row.receivingCount} cards`}
        </span>
      </span>
    </Link>
  );
}
