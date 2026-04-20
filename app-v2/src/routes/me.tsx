import { useAuth } from '../hooks/useAuth';
import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';
import { APP_COMMIT, APP_BUILD_TIME, isBetaChannel } from '../version';

export function MeRoute() {
  const auth = useAuth();

  return (
    <Screen title="Me">
      {auth.user ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4">
            {auth.user.avatarUrl ? (
              <img
                src={auth.user.avatarUrl}
                alt=""
                className="size-12 rounded-full"
                width={48}
                height={48}
              />
            ) : (
              <div
                aria-hidden="true"
                className="grid size-12 place-items-center rounded-full bg-accent/15 text-accent"
              >
                {auth.user.username.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{auth.user.username}</div>
              <div className="text-[length:var(--text-meta)] leading-[length:var(--text-meta--line-height)] text-fg-muted">
                @{auth.user.handle}
                {auth.user.isAnonymous ? ' (guest)' : null}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void auth.logout()}
            className="h-11 rounded-xl border border-border bg-surface text-danger hover:bg-border/40"
          >
            Sign out
          </button>
        </div>
      ) : (
        <EmptyState
          title="Sign in with Discord"
          body="Trade with friends, sync your wishlist and binder, and get notifications for new pitches."
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
      )}

      <footer
        className="mt-8 text-center text-[length:var(--text-caption)] leading-[length:var(--text-caption--line-height)] text-fg-muted"
        title={`Built ${APP_BUILD_TIME}`}
      >
        {isBetaChannel() ? 'beta · ' : 'v '}
        {APP_COMMIT}
      </footer>
    </Screen>
  );
}
