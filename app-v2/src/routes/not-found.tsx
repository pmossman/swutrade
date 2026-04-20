import { Link } from 'react-router';
import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';

export function NotFoundRoute() {
  return (
    <Screen withTabBar={false}>
      <EmptyState
        title="Nothing here"
        body="This path doesn't match a known screen. It may have been a trade link that's since settled or expired."
        action={
          <Link
            to="/"
            className="inline-flex h-11 items-center rounded-xl bg-accent px-6 font-semibold text-accent-fg"
          >
            Back to Trades
          </Link>
        }
      />
    </Screen>
  );
}
