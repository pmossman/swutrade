import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardVariant, PriceMode } from '../../types';
import type { AvailableApi } from '../../hooks/useAvailable';
import { cardFamilyId } from '../../variants';
import { useAuthContext } from '../../contexts/AuthContext';
import { useCardIndexContext } from '../../contexts/CardIndexContext';
import { usePopularWants } from '../../hooks/usePopularWants';
import { ListCardPicker } from '../ListCardPicker';
import { AvailableRow } from '../ListRows';
import { EmptyState } from '../ui/states';
import { ListToolbar, FilterAwareEmptyBody } from './ListToolbar';
import {
  applyListToolbar,
  variantTagFromCard,
  type ListFilters,
  type ListSortMode,
} from './applyListToolbar';
import { loadToolbarState, saveToolbarState } from './toolbarPersistence';

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
  /** Persistence key for the toolbar state. Default groups the drawer
   *  + dedicated view under one key. */
  toolbarSurfaceKey?: string;
}

const DEFAULT_EMPTY = {
  title: 'Your trade binder is empty',
  body: 'Save exact cards you have to trade. Matchmaking against other users comes later.',
};

export function AvailablePanel({
  available,
  allCards,
  percentage,
  priceMode,
  byProductId,
  emptyState = DEFAULT_EMPTY,
  toolbarSurfaceKey = 'binder',
}: AvailablePanelProps) {
  const [mode, setMode] = useState<'list' | 'picker'>('list');

  // byFamilyAll feeds the per-row swap popover — every row needs to
  // know which sibling print variants exist for its card so the
  // popover can render them as chips. Reading from context avoids a
  // prop-drill through BinderView + ListsDrawer.
  const { byFamilyAll } = useCardIndexContext();

  const initial = useMemo(
    () => loadToolbarState(toolbarSurfaceKey, 'default'),
    [toolbarSurfaceKey],
  );
  const [filters, setFilters] = useState<ListFilters>(initial.filters);
  const [sort, setSort] = useState<ListSortMode>(initial.sort);

  useEffect(() => {
    saveToolbarState(toolbarSurfaceKey, filters, sort);
  }, [toolbarSurfaceKey, filters, sort]);

  // "Popular wants" — per-productId list of other users whose
  // restriction would actually accept this binder row's variant.
  // Signed-in only; surfaces the social payoff of having a public
  // binder. The 2026-05-20 rewrite added variant-awareness +
  // wanter identities so the row badge can deep-link into a
  // user-picker popover (see ListRows.AvailableRow's PopularWanters
  // popover).
  const { user } = useAuthContext();
  const popularWantsInput = useMemo(() => {
    if (!user) return [];
    const items: { productId: string; familyId: string; variant: string }[] = [];
    for (const item of available.items) {
      const card = byProductId.get(item.productId);
      if (!card || !card.productId) continue;
      items.push({
        productId: item.productId,
        familyId: cardFamilyId(card),
        variant: variantTagFromCard(card),
      });
    }
    return items;
  }, [user, available.items, byProductId]);
  const popularWants = usePopularWants(popularWantsInput);

  // Stable reference so each AvailableRow's React.memo can short-circuit
  // when only `wantCounts` or another row changes. `available.update`
  // is itself useCallback'd in the hook, so this just shapes the call
  // signature for the row's `onChangeQty(id, qty)` API.
  const handleChangeQty = useCallback(
    (id: string, qty: number) => available.update(id, { qty }),
    [available],
  );

  // Variant swap: remove the old row + add a row for the new
  // productId, preserving qty + note. The remove+add detour (vs a
  // direct `update({ productId })`) makes the productId-dedup branch
  // in `availableAddReducer` fire — if the user already has a row
  // for the target variant, qty merges instead of producing two
  // rows for the same productId. No-op when the new card has no
  // productId (defensive — every catalog entry should).
  const handleSwapVariant = useCallback((id: string, newCard: CardVariant) => {
    if (!newCard.productId) return;
    const existing = available.items.find(i => i.id === id);
    if (!existing || existing.productId === newCard.productId) return;
    available.remove(id);
    available.add({
      productId: newCard.productId,
      qty: existing.qty,
      note: existing.note,
    });
  }, [available]);

  // Decorate each row with ListRowMeta so applyListToolbar can filter
  // + sort uniformly. variantTags for an AvailableItem is just the
  // concrete variant the card resolves to (binder rows are always
  // a specific printing — there's no "any" concept here).
  //
  // ⚠ Hooks order: these useMemos MUST run on every render, not just
  // when mode === 'list'. The earlier shape put them after the
  // `if (mode === 'picker') return` guard, which violated the
  // "hooks must fire in the same order every render" rule and
  // produced a "Rendered fewer hooks than expected" error the moment
  // a user toggled into picker mode after the toolbar code shipped.
  // Caught by the curate-and-share e2e (06dd0e7 CI failure).
  type DecoratedAvail = {
    item: AvailableApi['items'][number];
    card: CardVariant | null;
    addedAt: number;
    variantTags: string[];
  };

  const decoratedAll = useMemo<DecoratedAvail[]>(
    () => available.items.map(item => {
      const card = byProductId.get(item.productId) ?? null;
      return {
        item,
        card,
        addedAt: item.addedAt,
        variantTags: card ? [variantTagFromCard(card)] : [],
      };
    }),
    [available.items, byProductId],
  );

  const visibleRows = useMemo<DecoratedAvail[]>(
    () => applyListToolbar(decoratedAll, filters, sort, priceMode),
    [decoratedAll, filters, sort, priceMode],
  );

  // ⚠ Hooks order: see the warning above `decoratedAll`. These must
  // also live above `if (mode === 'picker')` for the same reason.
  const activeFilterAxisCount = useMemo(() => {
    let n = 0;
    if (filters.query.trim().length > 0) n++;
    if (filters.selectedSets.length > 0) n++;
    if (filters.selectedVariants.length > 0) n++;
    return n;
  }, [filters]);
  const handleClearFilters = useCallback(() => {
    setFilters({
      query: '',
      selectedSets: [],
      selectedVariants: [],
      priorityOnly: false,
      matchOnly: false,
    });
  }, []);

  if (mode === 'picker') {
    return (
      <ListCardPicker
        // Binder rows are productId-keyed; users have specific
        // printings, no "any" concept. Lock the picker to specific.
        selectionMode={{ kind: 'specific' }}
        allCards={allCards}
        percentage={percentage}
        priceMode={priceMode}
        savedChipLabel="In your binder"
        savedEntries={available.items.map(item => ({
          id: item.id,
          productId: item.productId,
          qty: item.qty,
        }))}
        onDecrement={id => {
          const item = available.items.find(i => i.id === id);
          if (!item) return;
          if (item.qty <= 1) available.remove(id);
          else available.update(id, { qty: item.qty - 1 });
        }}
        onPick={card => {
          if (!card.productId) return;
          available.add({ productId: card.productId, qty: 1 });
        }}
        onClose={() => setMode('list')}
      />
    );
  }

  const isListEmpty = available.items.length === 0;

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {!isListEmpty && (
          <ListToolbar
            mode="binder"
            filters={filters}
            onChangeFilters={setFilters}
            sort={sort}
            onChangeSort={setSort}
            totalCount={decoratedAll.length}
            filteredCount={visibleRows.length}
          />
        )}
        {isListEmpty ? (
          <EmptyState variant="centered" title={emptyState.title}>{emptyState.body}</EmptyState>
        ) : visibleRows.length === 0 ? (
          <EmptyState variant="centered" title="No matches">
            <FilterAwareEmptyBody
              activeCount={activeFilterAxisCount}
              onClear={handleClearFilters}
            />
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleRows.map(({ item, card }) => {
              const fid = card ? cardFamilyId(card) : null;
              const familyCandidates = fid ? byFamilyAll.get(fid) : undefined;
              const wanters = popularWants[item.productId];
              return (
                <AvailableRow
                  key={item.id}
                  item={item}
                  card={card}
                  percentage={percentage}
                  priceMode={priceMode}
                  wanters={wanters}
                  onChangeQty={handleChangeQty}
                  onRemove={available.remove}
                  familyCandidates={familyCandidates}
                  onSwapVariant={handleSwapVariant}
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
