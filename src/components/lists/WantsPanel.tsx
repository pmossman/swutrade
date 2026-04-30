import { useMemo, useState } from 'react';
import type { CardVariant, PriceMode } from '../../types';
import type { WantsApi } from '../../hooks/useWants';
import { cardFamilyId } from '../../variants';
import { bestMatchForWant } from '../../listMatching';
import { ListCardPicker } from '../ListCardPicker';
import { WantsRow } from '../ListRows';

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
}: WantsPanelProps) {
  const [mode, setMode] = useState<'list' | 'picker'>('list');
  const [editingWantId, setEditingWantId] = useState<string | null>(null);

  // Priority-first, then insertion order. Mirrors HomeView's
  // WishlistModule preview so the top-pinned rows are consistent
  // across both surfaces.
  const sortedWants = useMemo(() => {
    return [...wants.items].sort((a, b) => {
      const pa = a.isPriority ? 1 : 0;
      const pb = b.isPriority ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return a.addedAt - b.addedAt;
    });
  }, [wants.items]);

  if (mode === 'picker') {
    return (
      <ListCardPicker
        // Wishlist surface — saving with a specific variant is a
        // power-user move; default to family ("any printing") mode
        // since most adds are "I want any version of this card".
        // The toggle stays prominent at the top of the picker so
        // users can flip when they want a Hyperspace-only entry.
        selectionMode={{ kind: 'either', default: 'family' }}
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
          restrictionKey: item.restriction.mode === 'any'
            ? 'any'
            : [...item.restriction.variants].sort().join('|'),
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

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {sortedWants.length === 0 ? (
          <EmptyState title={emptyState.title} body={emptyState.body} />
        ) : (
          <ul className="flex flex-col gap-2">
            {sortedWants.map(item => {
              // Prefer the variant that satisfies the want's restriction
              // (e.g. Showcase art for a Showcase-restricted want).
              // Falls back to the family's Standard rep when no
              // candidates have loaded yet.
              const candidates = byFamilyAll.get(item.familyId) ?? [];
              const sampleCard =
                bestMatchForWant(item, candidates, priceMode)
                ?? byFamily.get(item.familyId)
                ?? null;
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

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-10 px-6 text-gray-400">
      <div className="text-sm font-semibold text-gray-300">{title}</div>
      <div className="text-[12px] leading-relaxed max-w-[22rem]">{body}</div>
    </div>
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
