import { useParams } from 'react-router';
import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';

export function ProfileRoute() {
  const { handle } = useParams<{ handle: string }>();
  return (
    <Screen title={`@${handle ?? ''}`} withTabBar={false}>
      <EmptyState
        title="Profile ships in Phase 2"
        body="Public wishlist + binder + Trade-with CTA. Placeholder route for now."
      />
    </Screen>
  );
}
