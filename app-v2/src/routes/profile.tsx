import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';
import { NavBar } from '../components/primitives/NavBar';
import { ActionBar } from '../components/primitives/ActionBar';
import { Segmented } from '../components/primitives/Segmented';
import { Chip } from '../components/primitives/Chip';
import { useRecipientProfile } from '../hooks/useRecipientProfile';
import { useAuth } from '../hooks/useAuth';
import { useProductIndex, useFamilyIndex } from '../hooks/useCardIndex';

type Tab = 'wants' | 'available';

export function ProfileRoute() {
  const { handle } = useParams<{ handle: string }>();
  const navigate = useNavigate();
  const auth = useAuth();
  const profile = useRecipientProfile(handle);
  const productIndex = useProductIndex();
  const familyIndex = useFamilyIndex();
  const [tab, setTab] = useState<Tab>('wants');

  const viewingOwn = !!auth.user && auth.user.handle === handle;

  if (profile.status === 'pending') {
    return (
      <Screen withTabBar={false}>
        <NavBar title={`@${handle}`} back="/" />
        <p className="px-4 py-8 text-center text-fg-muted">Loading profile…</p>
      </Screen>
    );
  }

  if (profile.status === 'error') {
    return (
      <Screen withTabBar={false}>
        <NavBar title={`@${handle}`} back="/" />
        <EmptyState
          title="Profile not found"
          body="This user doesn't exist or has made their profile private."
          action={
            <button
              type="button"
              onClick={() => navigate('/')}
              className="h-11 rounded-xl bg-accent px-6 font-semibold text-accent-fg"
            >
              Back to Trades
            </button>
          }
        />
      </Screen>
    );
  }

  const user = profile.data.user;
  const wants = profile.data.wants;
  const available = profile.data.available;
  const pIdx = productIndex.data;
  const fIdx = familyIndex.data;

  return (
    <Screen withTabBar={false}>
      <NavBar title={`@${user.handle}`} back="/" />

      <div className="flex flex-col gap-4 px-4 pt-3 pb-36">
        <header className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4">
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              className="size-14 rounded-full"
              width={56}
              height={56}
            />
          ) : (
            <div
              aria-hidden="true"
              className="grid size-14 place-items-center rounded-full bg-accent/15 text-[length:var(--text-title)] text-accent"
            >
              {user.username.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[length:var(--text-title)] font-semibold">
              {user.username}
            </div>
            <div className="truncate text-[length:var(--text-meta)] text-fg-muted">
              @{user.handle}
            </div>
          </div>
        </header>

        <div className="flex justify-center">
          <Segmented<Tab>
            ariaLabel="Profile section"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'wants', label: `Wants${wants ? ` · ${wants.length}` : ''}` },
              {
                value: 'available',
                label: `Binder${available ? ` · ${available.length}` : ''}`,
              },
            ]}
          />
        </div>

        {tab === 'wants' ? (
          wants === null ? (
            <EmptyState
              title="Wishlist is private"
              body={`@${user.handle} hasn't shared their wishlist publicly.`}
            />
          ) : wants.length === 0 ? (
            <EmptyState
              title="No wants listed yet"
              body={`@${user.handle} hasn't added anything to their wishlist.`}
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {wants.map((w) => {
                const variants = fIdx?.[w.familyId] ?? [];
                const name = variants[0]?.n ?? w.familyId.split('::')[1] ?? w.familyId;
                return (
                  <li
                    key={w.familyId}
                    className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{name}</span>
                      <span className="block truncate text-[length:var(--text-meta)] text-fg-muted">
                        {w.restriction.mode === 'any'
                          ? 'Any variant'
                          : w.restriction.variants.join(' · ')}
                      </span>
                    </span>
                    {w.isPriority ? <Chip tone="attention">★ Priority</Chip> : null}
                    <span className="tabular-nums text-[length:var(--text-meta)] text-fg-muted">
                      × {w.qty}
                    </span>
                  </li>
                );
              })}
            </ul>
          )
        ) : available === null ? (
          <EmptyState
            title="Binder is private"
            body={`@${user.handle} hasn't shared their binder publicly.`}
          />
        ) : available.length === 0 ? (
          <EmptyState
            title="Binder is empty"
            body={`@${user.handle} hasn't listed any cards yet.`}
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {available.map((a) => {
              const card = pIdx?.[a.productId];
              return (
                <li
                  key={a.productId}
                  className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {card?.n ?? `Card ${a.productId}`}
                    </span>
                    {card ? (
                      <span className="block truncate text-[length:var(--text-meta)] text-fg-muted">
                        {card.s}
                      </span>
                    ) : null}
                  </span>
                  <span className="tabular-nums text-[length:var(--text-meta)] text-fg-muted">
                    × {a.qty}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!viewingOwn ? (
        <ActionBar
          primary={
            <button
              type="button"
              onClick={() => navigate(`/compose?to=${encodeURIComponent(user.handle)}`)}
              className="h-11 w-full rounded-xl bg-accent font-semibold text-accent-fg"
            >
              Trade with @{user.handle}
            </button>
          }
        />
      ) : null}
    </Screen>
  );
}
