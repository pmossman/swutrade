import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';

export function CommunityRoute() {
  return (
    <Screen title="Community">
      <EmptyState
        title="Community ships in Phase 2"
        body="Guild directory + per-server member list. For now, this tab is a placeholder."
      />
    </Screen>
  );
}
