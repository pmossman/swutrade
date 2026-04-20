import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';
import { FAB } from '../components/primitives/FAB';
import { useCreateOpenSession } from '../hooks/useCreateOpenSession';

export function TradesRoute() {
  const navigate = useNavigate();
  const createOpen = useCreateOpenSession();
  const [errorOpen, setErrorOpen] = useState(false);

  async function startTrade() {
    setErrorOpen(false);
    try {
      const res = await createOpen.mutateAsync();
      navigate(`/s/${res.id}`);
    } catch {
      // Design §10 1d exit criterion: no offline queue. Surface the
      // failure inline with a Retry. Covered by e2e/home.spec.ts's
      // network-failure test.
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

      <EmptyState
        title="You haven't traded yet"
        body="Tap the + button to start a trade at a game store, pitch one async, or build a balance solo."
      />

      <FAB
        ariaLabel="Start trade"
        onClick={startTrade}
      />
    </Screen>
  );
}
