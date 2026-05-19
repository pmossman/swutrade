import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardVariant, PriceMode } from '../../types';
import type { WantsApi } from '../../hooks/useWants';
import { CANONICAL_VARIANTS, cardFamilyId } from '../../variants';
import { bestMatchForWant } from '../../listMatching';
import { ListCardPicker } from '../ListCardPicker';
import { WantsRow } from '../ListRows';
import { restrictionKey } from '../../../lib/shared';
import { EmptyState } from '../ui/states';
import { ListToolbar } from './ListToolbar';
import {
  applyListToolbar,
  type ListFilters,
  type ListSortMode,
} from './applyListToolbar';
import { loadToolbarState, saveToolbarState } from './toolbarPersistence';

/**
 * Shared wants-list body used by both the embedded drawer (quick-edit
 * sidebar inside the trade builder) and the dedicated WishlistView
 * (full-page surface reached from Home + NavMenu). Owns its own
 * picker mode + edit-row state so the two callers don't have to
 * coordinate.
 *
 * Was inlined inside `ListsDrawer` until the Wishlist / Binder split —
 * lifted out so the dedicated view can render it at full page height
 * without reimplementing the list + picker + per-row editing chrome.
 */
interface WantsPanelProps {
  wants: WantsApi;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
  /** family id → best single-variant representative (prefers Standard
   *  when both exist). Used as a fallback thumbnail. */
  byFamily: Map<string, CardVariant>;
  /** family id → every loaded variant for that family. Used by
   *  `bestMatchForWant` to pick the variant that satisfies each
   *  want's restriction (e.g. Showcase art for a Showcase-only want). */
  byFamilyAll: Map<string, CardVariant[]>;
  /** Copy shown in the empty-state card. Drawer and dedicated-view
   *  pitch the same list differently. */
  emptyState?: { title: string; body: string };
  /** Persistence + analytics key for the toolbar state. Default
   *  groups the drawer + dedicated view under one key so a user who
   *  narrows their wishlist in one surface sees the same filters in
   *  the other. */
  toolbarSurfaceKey?: string;
}

const DEFAULT_EMPTY = {
  title: 'Your wishlist is empty',
  body: "Save cards you're looking for. You'll be able to add them to trades in one tap.",
};

export function WantsPanel({
  wants,
  allCards,
  percentage,
  priceMode,
  byFamily,
  byFamilyAll,
  emptyState = DEFAULT_EMPTY,
  toolbarSurfaceKey = 'wishlist',
}: WantsPanelProps) {
  const [mode, setMode] = useState<'list' | 'picker'>('list');
  const [editingWantId, setEditingWantId] = useState<string | null>(null);

  // Toolbar state — restored from localStorage on mount (except query,
  // which always starts empty so search doesn't surprise the user
  // across navigations). Persisted on every change.
  const initial = useMemo(
    () => loadToolbarState(toolbarSurfaceKey, 'default'),
    [toolbarSurfaceKey],
  );
  const [filters, setFilters] = useState<ListFilters>(initial.filters);
  const [sort, setSort] = useState<ListSortMode>(initial.sort);

  useEffect(() => {
    saveToolbarState(toolbarSurfaceKey, filters, sort);
  }, [toolbarSurfaceKey, filters, sort]);

  // Materialize the rows the toolbar needs to filter+sort. Each row
  // carries:
  //   - card: best sample for displayName + variant + set + price
  //   - variantTags: which canonical variants this want represents
  //     (all of them for restriction.any; just the listed ones for
  //     restriction.restricted) so the variant chip filter can
  //     evaluate the row without re-reading the restriction.
  type DecoratedRow = ReturnType<typeof decorate>;
  const decorate = useCallback((item: WantsApi['items'][number]) => {
    const candidates = byFamilyAll.get(item.familyId) ?? [];
    const sampleCard =
      bestMatchForWant(item, candidates, priceMode)
      ?? byFamily.get(item.familyId)
      ?? null;
    const variantTags = item.restriction.mode === 'restricted'
      ? item.restriction.variants
      : [...CANONICAL_VARIANTS];
    return {
      item,
      card: sampleCard,
      addedAt: item.addedAt,
      variantTags,
      isPriority: item.isPriority,
    };
  }, [byFamily, byFamilyAll, priceMode]);

  const decoratedAll = useMemo<DecoratedRow[]>(
    () => wants.items.map(decorate),
    [wants.items, decorate],
  );

  const visibleWants = useMemo<DecoratedRow[]>(
    () => applyListToolbar(decoratedAll, filters, sort, priceMode),
    [decoratedAll, filters, sort, priceMode],
  );

  if (mode === 'picker') {
    return (
      <ListCardPicker
        // Wishlist surface — family-level entries by default. The
        // variant filter chips at the top of the picker drive the
        // saved restriction: empty filter → "any printing"; selecting
        // [Hyperspace] → click saves as Hyperspace-only.
        selectionMode={{ kind: 'family' }}
        allCards={allCards}
        percentage={percentage}
        priceMode={priceMode}
        savedEntries={wants.items.map(item => ({
          id: item.id,
          familyId: item.familyId,
          qty: item.qty,
          // Encode the saved restriction so the picker only badges a
          // tile when its current variant filter matches — Hyperspace-
          // saved Luke shouldn't badge under a "Standard" filter, that's
          // a different intent.
          restrictionKey: restrictionKey(item.restriction),
        }))}
        onDecrement={id => {
          const item = wants.items.find(i => i.id === id);
          if (!item) return;
          if (item.qty <= 1) wants.remove(id);
          else wants.update(id, { qty: item.qty - 1 });
        }}
        onPick={(card, ctx) => {
          // Variant filter (acceptedVariants) drives the saved
          // restriction. Empty filter → any. Otherwise → restricted
          // to the filter set.
          const accepted = ctx.acceptedVariants ?? [];
          const restriction = accepted.length > 0
            ? { mode: 'restricted' as const, variants: accepted }
            : { mode: 'any' as const };
          wants.add({ familyId: cardFamilyId(card), qty: 1, restriction });
        }}
        onClose={() => setMode('list')}
      />
    );
  }

  const isListEmpty = wants.items.length === 0;
  const hasActiveFilters = visibleWants.length !== decoratedAll.length;

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {!isListEmpty && (
          <ListToolbar
            mode="wishlist"
            filters={filters}
            onChangeFilters={setFilters}
            sort={sort}
            onChangeSort={setSort}
            totalCount={decoratedAll.length}
            filteredCount={visibleWants.length}
          />
        )}
        {isListEmpty ? (
          <EmptyState variant="centered" title={emptyState.title}>{emptyState.body}</EmptyState>
        ) : visibleWants.length === 0 ? (
          <EmptyState variant="centered" title="No matches">
            {hasActiveFilters
              ? "Your filters are hiding every row. Try Clear all."
              : 'Nothing to show.'}
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleWants.map(({ item, card: sampleCard }) => {
              const candidates = byFamilyAll.get(item.familyId) ?? [];
              return (
                <WantsRow
                  key={item.id}
                  item={item}
                  sampleCard={sampleCard}
                  familyCandidates={candidates}
                  isEditing={editingWantId === item.id}
                  onChangeQty={qty => wants.update(item.id, { qty })}
                  onTogglePriority={() => wants.togglePriority(item.id)}
                  onRemove={() => {
                    if (editingWantId === item.id) setEditingWantId(null);
                    wants.remove(item.id);
                  }}
                  onToggleEdit={() =>
                    setEditingWantId(prev => (prev === item.id ? null : item.id))
                  }
                  onChangeRestriction={next =>
                    wants.update(item.id, { restriction: next })
                  }
                />
              );
            })}
          </ul>
        )}
      </div>
      <AddCardFooter onClick={() => setMode('picker')} accent="blue" />
    </>
  );
}


function AddCardFooter({ onClick, accent }: { onClick: () => void; accent: 'blue' | 'emerald' }) {
  const accentClass = accent === 'blue'
    ? 'bg-blue-500/10 border-blue-500/30 text-blue-200 hover:bg-blue-500/20 hover:border-blue-500/50'
    : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/20 hover:border-emerald-500/50';
  return (
    <div className="shrink-0 border-t border-space-800 p-3">
      <button
        type="button"
        onClick={onClick}
        className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-colors text-xs font-bold tracking-[0.1em] uppercase ${accentClass}`}
      >
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
          <path d="M8 3v10M3 8h10" />
        </svg>
        Add Card
      </button>
    </div>
  );
}
