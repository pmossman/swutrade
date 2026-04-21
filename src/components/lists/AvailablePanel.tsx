import { useMemo, useState } from 'react';
import type { CardVariant, PriceMode } from '../../types';
import type { AvailableApi } from '../../hooks/useAvailable';
import { cardFamilyId } from '../../variants';
import { useAuthContext } from '../../contexts/AuthContext';
import { usePopularWants } from '../../hooks/usePopularWants';
import { ListCardPicker } from '../ListCardPicker';
import { AvailableRow } from '../ListRows';

/**
 * Shared available/binder body used by both the embedded drawer
 * (quick-edit sidebar inside the trade builder) and the dedicated
 * BinderView (full-page surface reached from Home + NavMenu).
 * Owns its own picker mode; per-row state is simpler than Wants
 * (no priority, no variant restriction, so no per-row editing toggle).
 *
 * Was inlined inside `ListsDrawer` until the Wishlist / Binder split —
 * lifted out so the dedicated view can render it at full page height
 * without reimplementing the popular-wants social signal + picker.
 */
interface AvailablePanelProps {
  available: AvailableApi;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
  /** productId → CardVariant. Drives the row thumbnails + variant pill
   *  display. Missing entries (card not yet loaded) render a placeholder. */
  byProductId: Map<string, CardVariant>;
  emptyState?: { title: string; body: string };
}

const DEFAULT_EMPTY = {
  title: 'No available cards yet',
  body: 'Save exact cards you have to trade. Matchmaking against other users comes later.',
};

export function AvailablePanel({
  available,
  allCards,
  percentage,
  priceMode,
  byProductId,
  emptyState = DEFAULT_EMPTY,
}: AvailablePanelProps) {
  const [mode, setMode] = useState<'list' | 'picker'>('list');

  // "Popular wants" — how many other users have each of our binder
  // cards' families on their public wants list. Signed-in only;
  // surfaces the social payoff of having a public binder.
  const { user } = useAuthContext();
  const availableFamilyIds = useMemo<string[]>(() => {
    if (!user) return [];
    const ids = new Set<string>();
    for (const item of available.items) {
      const card = byProductId.get(item.productId);
      if (card) ids.add(cardFamilyId(card));
    }
    return [...ids];
  }, [user, available.items, byProductId]);
  const wantCounts = usePopularWants(availableFamilyIds);

  if (mode === 'picker') {
    return (
      <ListCardPicker
        listType="available"
        allCards={allCards}
        percentage={percentage}
        priceMode={priceMode}
        available={available}
        onPick={card => {
          if (!card.productId) return;
          available.add({ productId: card.productId, qty: 1 });
        }}
        onClose={() => setMode('list')}
      />
    );
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {available.items.length === 0 ? (
          <EmptyState title={emptyState.title} body={emptyState.body} />
        ) : (
          <ul className="flex flex-col gap-2">
            {available.items.map(item => {
              const card = byProductId.get(item.productId) ?? null;
              const fid = card ? cardFamilyId(card) : null;
              return (
                <AvailableRow
                  key={item.id}
                  item={item}
                  card={card}
                  percentage={percentage}
                  priceMode={priceMode}
                  wantCount={fid ? wantCounts[fid] : undefined}
                  onChangeQty={qty => available.update(item.id, { qty })}
                  onRemove={() => available.remove(item.id)}
                />
              );
            })}
          </ul>
        )}
      </div>
      <AddCardFooter onClick={() => setMode('picker')} />
    </>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-10 px-6 text-gray-400">
      <div className="text-sm font-semibold text-gray-300">{title}</div>
      <div className="text-[12px] leading-relaxed max-w-[22rem]">{body}</div>
    </div>
  );
}

function AddCardFooter({ onClick }: { onClick: () => void }) {
  return (
    <div className="shrink-0 border-t border-space-800 p-3">
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border bg-emerald-500/10 border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/20 hover:border-emerald-500/50 transition-colors text-xs font-bold tracking-[0.1em] uppercase"
      >
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
          <path d="M8 3v10M3 8h10" />
        </svg>
        Add Card
      </button>
    </div>
  );
}
