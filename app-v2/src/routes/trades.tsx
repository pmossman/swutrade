import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';

export function TradesRoute() {
  return (
    <Screen title="Trades">
      <EmptyState
        title="You haven't traded yet"
        body="Tap the + button to start a trade at a game store, pitch one async, or build a balance solo."
      />
    </Screen>
  );
}
