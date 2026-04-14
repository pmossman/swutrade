import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import type { CardVariant, PriceMode } from '../types';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import type { useSearchFilters } from '../hooks/useVariantFilter';
import { ListCardPicker } from './ListCardPicker';
import { extractVariantLabel, cardFamilyId, CANONICAL_VARIANTS, type CanonicalVariant } from '../variants';
import { WantsRow, AvailableRow } from './ListRows';

interface ListsDrawerProps {
  wants: WantsApi;
  available: AvailableApi;
  filters: ReturnType<typeof useSearchFilters>;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
  onPriceModeChange: (mode: PriceMode) => void;
}

type ListTab = 'wants' | 'available';
type Mode = 'list' | 'picker';

/**
 * Mobile: bottom sheet sliding up from viewport bottom.
 * Desktop: centered modal.
 */
export function ListsDrawer({
  wants,
  available,
  filters,
  allCards,
  percentage,
  priceMode,
  onPriceModeChange,
}: ListsDrawerProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ListTab>('wants');
  const [mode, setMode] = useState<Mode>('list');
  const [editingWantId, setEditingWantId] = useState<string | null>(null);

  const wantsCount = wants.items.length;
  const availableCount = available.items.length;
  const totalCount = wantsCount + availableCount;

  // Drawer rows display image + display name (wants) or exact variant
  // (available). Add-to-trade flows through the trade overlay's empty-
  // state lists section now, so we don't need the full byFamilyAll map.
  const { byFamily, byProductId } = useMemo(() => {
    const byFamily = new Map<string, CardVariant>();
    const byProductId = new Map<string, CardVariant>();
    for (const card of allCards) {
      if (card.productId) byProductId.set(card.productId, card);
      const fid = cardFamilyId(card);
      const existing = byFamily.get(fid);
      if (!existing || card.variant === 'Standard') byFamily.set(fid, card);
    }
    return { byFamily, byProductId };
  }, [allCards]);

  // Saved-count maps for picker tile badges. Keyed by:
  //   - wants: familyId → total qty across all wants items for that card
  //   - available: productId → qty for that exact variant
  const wantsSavedCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const item of wants.items) {
      m.set(item.familyId, (m.get(item.familyId) ?? 0) + item.qty);
    }
    return m;
  }, [wants.items]);

  const availableSavedCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const item of available.items) {
      m.set(item.productId, (m.get(item.productId) ?? 0) + item.qty);
    }
    return m;
  }, [available.items]);

  // Priority-first sort for wants, insertion order otherwise
  const sortedWants = useMemo(() => {
    return [...wants.items].sort((a, b) => {
      const pa = a.isPriority ? 1 : 0;
      const pb = b.isPriority ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return a.addedAt - b.addedAt;
    });
  }, [wants.items]);

  // Close the picker whenever the drawer or tab changes.
  const handleTabChange = (next: ListTab) => {
    setTab(next);
    setMode('list');
  };
  const handleOpenChange = (next: boolean) => {
    if (!next) setMode('list');
    setOpen(next);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Open my lists"
          className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-300 hover:text-gold"
        >
          <ListsIcon className="w-3.5 h-3.5" />
          <span className="hidden sm:inline tracking-wide uppercase">My Lists</span>
          {totalCount > 0 && (
            <span className="ml-0.5 px-1.5 py-px rounded-full bg-gold/20 text-gold text-[10px] font-bold leading-none">
              {totalCount}
            </span>
          )}
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          data-mode={mode}
          className={[
            'drawer-content z-50 bg-space-900 border border-space-700 text-gray-100 shadow-2xl',
            'flex flex-col',
            // Mobile list mode: bottom sheet. Mobile picker mode:
            // expands to full viewport so the search results have
            // room to breathe (iOS address bar etc.).
            'max-h-[85dvh] rounded-t-2xl border-b-0',
            'data-[mode=picker]:max-h-[100dvh] data-[mode=picker]:h-[100dvh] data-[mode=picker]:rounded-none',
            // Desktop: fixed modal size in either mode.
            'md:w-[min(720px,calc(100vw-2rem))] md:max-h-[85dvh] md:h-auto md:rounded-2xl md:border md:data-[mode=picker]:max-h-[85dvh] md:data-[mode=picker]:rounded-2xl',
          ].join(' ')}
        >
          {/* Drag-handle affordance (mobile only, hidden in full-screen picker) */}
          {mode === 'list' && (
            <div className="flex justify-center pt-2 md:hidden">
              <span className="w-10 h-1 rounded-full bg-space-700" aria-hidden />
            </div>
          )}

          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-space-800">
            <Dialog.Title className="text-sm font-bold tracking-[0.1em] uppercase text-gold">
              My Lists
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="text-gray-500 hover:text-gray-200 transition-colors"
              >
                <CloseIcon className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          <Tabs.Root
            value={tab}
            onValueChange={v => handleTabChange(v as ListTab)}
            className="flex flex-col flex-1 min-h-0"
          >
            <Tabs.List
              className="flex gap-1 px-3 pt-2 border-b border-space-800"
              aria-label="Wants and Available lists"
            >
              <TabTrigger value="wants" count={wantsCount}>Wants</TabTrigger>
              <TabTrigger value="available" count={availableCount}>Available</TabTrigger>
            </Tabs.List>

            <Tabs.Content value="wants" className="flex-1 min-h-0 data-[state=inactive]:hidden flex flex-col">
              {mode === 'picker' && tab === 'wants' ? (
                <ListCardPicker
                  listType="wants"
                  allCards={allCards}
                  filters={filters}
                  percentage={percentage}
                  priceMode={priceMode}
                  onPriceModeChange={onPriceModeChange}
                  title="Add to Wants"
                  savedCounts={wantsSavedCounts}
                  onPick={(card, ctx) => {
                    const variant = extractVariantLabel(card.name);
                    // Only save a restricted variant if it's canonical —
                    // promo-only labels like "(Judge)" or "(Top 8)" don't
                    // match the schema enum, so those fall back to Any.
                    const isCanonical = (CANONICAL_VARIANTS as readonly string[]).includes(variant);
                    // Force Specific when the visible tile represents a
                    // non-Standard variant — the user's choice of tile
                    // signals intent. Showcase Leaders especially: search
                    // "showcase" filters the family to that single tile,
                    // and tapping it should save Specific[Showcase], not
                    // "any printing of this card."
                    const visibleIsNonStandard = isCanonical && variant !== 'Standard';
                    const useSpecific = isCanonical
                      && (ctx.wantsMode === 'specific' || visibleIsNonStandard);
                    const restriction = useSpecific
                      ? { mode: 'restricted' as const, variants: [variant as CanonicalVariant] }
                      : { mode: 'any' as const };
                    wants.add({ familyId: cardFamilyId(card), qty: 1, restriction });
                  }}
                  onClose={() => setMode('list')}
                />
              ) : (
                <>
                  <div className="flex-1 min-h-0 overflow-y-auto p-3">
                    {sortedWants.length === 0 ? (
                      <EmptyState
                        title="No wants yet"
                        body="Save cards you're looking for. You'll be able to add them to trades in one tap."
                      />
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {sortedWants.map(item => (
                          <WantsRow
                            key={item.id}
                            item={item}
                            sampleCard={byFamily.get(item.familyId) ?? null}
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
                        ))}
                      </ul>
                    )}
                  </div>
                  <AddCardFooter onClick={() => setMode('picker')} />
                </>
              )}
            </Tabs.Content>

            <Tabs.Content value="available" className="flex-1 min-h-0 data-[state=inactive]:hidden flex flex-col">
              {mode === 'picker' && tab === 'available' ? (
                <ListCardPicker
                  listType="available"
                  allCards={allCards}
                  filters={filters}
                  percentage={percentage}
                  priceMode={priceMode}
                  onPriceModeChange={onPriceModeChange}
                  title="Add to Available"
                  savedCounts={availableSavedCounts}
                  onPick={card => {
                    if (!card.productId) return;
                    available.add({ productId: card.productId, qty: 1 });
                  }}
                  onClose={() => setMode('list')}
                />
              ) : (
                <>
                  <div className="flex-1 min-h-0 overflow-y-auto p-3">
                    {available.items.length === 0 ? (
                      <EmptyState
                        title="No available cards yet"
                        body="Save exact cards you have to trade. Matchmaking against other users comes later."
                      />
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {available.items.map(item => (
                          <AvailableRow
                            key={item.id}
                            item={item}
                            card={byProductId.get(item.productId) ?? null}
                            percentage={percentage}
                            priceMode={priceMode}
                            onChangeQty={qty => available.update(item.id, { qty })}
                            onRemove={() => available.remove(item.id)}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                  <AddCardFooter onClick={() => setMode('picker')} />
                </>
              )}
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AddCardFooter({ onClick }: { onClick: () => void }) {
  return (
    <div className="shrink-0 border-t border-space-800 p-3">
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-gold/10 border border-gold/30 text-gold hover:bg-gold/20 hover:border-gold/50 transition-colors text-xs font-bold tracking-[0.1em] uppercase"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add Card
      </button>
    </div>
  );
}

function TabTrigger({
  value,
  count,
  children,
}: {
  value: ListTab;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Tabs.Trigger
      value={value}
      className={[
        'relative flex items-center gap-1.5 px-3 py-2 text-xs font-bold tracking-[0.08em] uppercase rounded-t-md',
        'text-gray-500 hover:text-gray-300 transition-colors',
        'data-[state=active]:text-gold',
        'after:content-[""] after:absolute after:bottom-0 after:inset-x-2 after:h-px after:bg-transparent',
        'data-[state=active]:after:bg-gold',
      ].join(' ')}
    >
      {children}
      {count > 0 && (
        <span className="px-1.5 py-px rounded-full bg-space-700 text-gray-300 text-[10px] font-bold leading-none">
          {count}
        </span>
      )}
    </Tabs.Trigger>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 gap-2">
      <div className="text-sm font-semibold text-gray-300">{title}</div>
      <div className="text-xs text-gray-500 max-w-sm">{body}</div>
    </div>
  );
}

function ListsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.5" y="3" width="11" height="2.25" rx="0.5" />
      <rect x="2.5" y="7" width="11" height="2.25" rx="0.5" />
      <rect x="2.5" y="11" width="11" height="2.25" rx="0.5" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 4L12 12M4 12L12 4" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M8 3V13M3 8H13" />
    </svg>
  );
}
