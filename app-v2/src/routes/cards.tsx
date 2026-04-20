import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';

export function CardsRoute() {
  return (
    <Screen title="Cards">
      <EmptyState
        title="Cards tab (coming in 1c)"
        body="Binder and Wishlist land in the next sub-phase. This route is a placeholder while scaffolding settles."
      />
    </Screen>
  );
}
