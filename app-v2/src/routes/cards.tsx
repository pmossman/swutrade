import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';
import { FAB } from '../components/primitives/FAB';
import { Segmented } from '../components/primitives/Segmented';
import { Stepper } from '../components/primitives/Stepper';
import { Chip } from '../components/primitives/Chip';
import { CardPicker } from '../components/CardPicker';
import { useAuth } from '../hooks/useAuth';
import { useBinder, type BinderItem } from '../hooks/useBinder';
import { useWishlist, type WishlistItem } from '../hooks/useWishlist';
import { useProductIndex, useFamilyIndex } from '../hooks/useCardIndex';
import { cardFamilyId } from '../lib/cards';

type Segment = 'binder' | 'wishlist';

export function CardsRoute() {
  const auth = useAuth();
  const [params, setParams] = useSearchParams();
  const segment: Segment = params.get('list') === 'wishlist' ? 'wishlist' : 'binder';
  const [pickerOpen, setPickerOpen] = useState(false);

  const binder = useBinder();
  const wishlist = useWishlist();

  function setSegment(next: Segment) {
    const p = new URLSearchParams(params);
    if (next === 'binder') p.delete('list');
    else p.set('list', 'wishlist');
    setParams(p, { replace: true });
  }

  // Ghost + signed-out see the same sign-in prompt per design §4.5/§4.6.
  // Ghosts skip server writes because the ghost-merge path doesn't
  // rewrite wants/available foreign keys — anything they'd write gets
  // orphaned on sign-in, and the design calls that out as "promise
  // broken" UX.
  if (auth.user?.isAnonymous || (!auth.user && !auth.isLoading)) {
    return (
      <Screen title="Cards">
        <GhostCardsState onSignIn={auth.login} />
      </Screen>
    );
  }

  return (
    <Screen title="Cards">
      <div className="mb-3 flex justify-center">
        <Segmented<Segment>
          ariaLabel="Cards section"
          value={segment}
          onChange={setSegment}
          options={[
            { value: 'binder', label: 'Binder' },
            { value: 'wishlist', label: 'Wishlist' },
          ]}
        />
      </div>

      {segment === 'binder' ? (
        <BinderList binder={binder} />
      ) : (
        <WishlistList wishlist={wishlist} />
      )}

      <FAB
        ariaLabel={segment === 'binder' ? 'Add to Binder' : 'Add to Wishlist'}
        onClick={() => setPickerOpen(true)}
      />

      <CardPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={segment === 'binder' ? 'Add to Binder' : 'Add to Wishlist'}
        onPick={(card) => {
          if (segment === 'binder') {
            binder.add(card.productId);
          } else {
            wishlist.add(cardFamilyId(card));
          }
          setPickerOpen(false);
        }}
      />
    </Screen>
  );
}

function BinderList({ binder }: { binder: ReturnType<typeof useBinder> }) {
  const productIndex = useProductIndex();

  if (binder.status === 'pending') {
    return <p className="px-1 text-[length:var(--text-meta)] text-fg-muted">Loading binder…</p>;
  }
  if (binder.status === 'error') {
    return (
      <p className="px-1 text-[length:var(--text-meta)] text-danger">
        Couldn't load your binder. Try again.
      </p>
    );
  }
  if (binder.items.length === 0) {
    return (
      <EmptyState
        title="No cards in your binder yet"
        body="Tap + to add the cards you have to trade."
      />
    );
  }

  const idx = productIndex.data;
  const sorted = [...binder.items].sort((a: BinderItem, b: BinderItem) => b.addedAt - a.addedAt);

  return (
    <ul className="flex flex-col gap-1">
      {sorted.map((item) => {
        const card = idx?.[item.productId];
        return (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">
                {card?.n ?? `Card ${item.productId}`}
              </span>
              {card ? (
                <span className="block truncate text-[length:var(--text-meta)] text-fg-muted">
                  {card.s}
                </span>
              ) : null}
            </span>
            <Stepper
              value={item.qty}
              min={0}
              onChange={(q) => binder.setQty(item.id, q)}
              ariaLabel={`Quantity of ${card?.n ?? 'card'}`}
            />
          </li>
        );
      })}
    </ul>
  );
}

function WishlistList({ wishlist }: { wishlist: ReturnType<typeof useWishlist> }) {
  const familyIndex = useFamilyIndex();

  const sorted = useMemo(() => {
    return [...wishlist.items].sort((a: WishlistItem, b: WishlistItem) => {
      const pa = a.isPriority ? 1 : 0;
      const pb = b.isPriority ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return b.addedAt - a.addedAt;
    });
  }, [wishlist.items]);

  if (wishlist.status === 'pending') {
    return <p className="px-1 text-[length:var(--text-meta)] text-fg-muted">Loading wishlist…</p>;
  }
  if (wishlist.status === 'error') {
    return (
      <p className="px-1 text-[length:var(--text-meta)] text-danger">
        Couldn't load your wishlist. Try again.
      </p>
    );
  }
  if (wishlist.items.length === 0) {
    return (
      <EmptyState
        title="No cards on your wishlist yet"
        body="Tap + to add the cards you're hoping to find."
      />
    );
  }

  const idx = familyIndex.data;

  return (
    <ul className="flex flex-col gap-1">
      {sorted.map((item) => {
        const variants = idx?.[item.familyId] ?? [];
        const displayName = variants[0]?.n ?? item.familyId.split('::')[1] ?? item.familyId;
        return (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2"
          >
            <button
              type="button"
              aria-label={item.isPriority ? 'Remove priority' : 'Mark as priority'}
              onClick={() => wishlist.togglePriority(item.id)}
              className="grid size-11 place-items-center rounded-full text-fg-muted hover:bg-border/30"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill={item.isPriority ? 'var(--state-attention)' : 'none'}
                stroke={item.isPriority ? 'var(--state-attention)' : 'currentColor'}
                strokeWidth="1.5"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10 2l2.5 5 5.5.8-4 3.9.9 5.6L10 14.8l-4.9 2.5.9-5.6-4-3.9 5.5-.8z" />
              </svg>
            </button>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{displayName}</span>
              <span className="block truncate text-[length:var(--text-meta)] text-fg-muted">
                {item.restriction.mode === 'any'
                  ? 'Any variant'
                  : item.restriction.variants.join(' · ')}
              </span>
            </span>
            {item.isPriority ? (
              <Chip tone="attention" ariaLabel="Priority">
                ★ Priority
              </Chip>
            ) : null}
            <Stepper
              value={item.qty}
              min={0}
              onChange={(q) => wishlist.setQty(item.id, q)}
              ariaLabel={`Quantity of ${displayName}`}
            />
          </li>
        );
      })}
    </ul>
  );
}

function GhostCardsState({ onSignIn }: { onSignIn: () => void }) {
  return (
    <EmptyState
      title="Sign in to keep a list of your cards"
      body="Your binder and wishlist need a Discord account so they follow you between devices and your trades can match against them."
      action={
        <button
          type="button"
          onClick={onSignIn}
          className="h-11 rounded-xl bg-accent px-6 font-semibold text-accent-fg"
        >
          Continue with Discord
        </button>
      }
    />
  );
}
