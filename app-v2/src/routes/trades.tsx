import { useState } from 'react';
import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';
import { FAB } from '../components/primitives/FAB';
import { Sheet } from '../components/primitives/Sheet';

export function TradesRoute() {
  const [startOpen, setStartOpen] = useState(false);

  return (
    <Screen title="Trades">
      <EmptyState
        title="You haven't traded yet"
        body="Tap the + button to start a trade at a game store, pitch one async, or build a balance solo."
      />

      <FAB ariaLabel="Start trade" onClick={() => setStartOpen(true)} />

      <Sheet open={startOpen} onOpenChange={setStartOpen} title="Start trade" snap="half">
        <p className="text-[length:var(--text-meta)] text-fg-muted">
          QR handoff + invite-by-handle ship in sub-phase 1e. This sheet is a
          Phase-1b scaffold to verify the Sheet primitive renders with
          spring-physics drag, reduced-motion fallback, and Radix focus-trap.
        </p>
      </Sheet>
    </Screen>
  );
}
