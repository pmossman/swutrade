import { useCallback, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import type { CardVariant, PriceMode } from '../types';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import { ListCardPicker } from './ListCardPicker';
import { cardFamilyId } from '../variants';
import { WantsRow, AvailableRow } from './ListRows';
import { encodeWants, encodeAvailable } from '../urlCodec';
import { bestMatchForWant } from '../listMatching';
import { TradeImageModal } from './TradeImageModal';

interface ListsDrawerProps {
  wants: WantsApi;
  available: AvailableApi;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
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
  allCards,
  percentage,
  priceMode,
}: ListsDrawerProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ListTab>('wants');
  const [mode, setMode] = useState<Mode>('list');
  const [editingWantId, setEditingWantId] = useState<string | null>(null);

  const wantsCount = wants.items.length;
  const availableCount = available.items.length;
  const totalCount = wantsCount + availableCount;

  // Drawer rows display image + display name (wants) or exact variant
  // (available). For wants, the row's thumbnail should reflect the
  // restriction — a Showcase-only want should show the Showcase art,
  // not the family's Standard rep. byFamilyAll powers bestMatchForWant
  // which picks the right variant per item.
  const { byFamily, byFamilyAll, byProductId } = useMemo(() => {
    const byFamily = new Map<string, CardVariant>();
    const byFamilyAll = new Map<string, CardVariant[]>();
    const byProductId = new Map<string, CardVariant>();
    for (const card of allCards) {
      if (card.productId) byProductId.set(card.productId, card);
      const fid = cardFamilyId(card);
      const existing = byFamily.get(fid);
      if (!existing || card.variant === 'Standard') byFamily.set(fid, card);
      const bucket = byFamilyAll.get(fid);
      if (bucket) bucket.push(card);
      else byFamilyAll.set(fid, [card]);
    }
    return { byFamily, byFamilyAll, byProductId };
  }, [allCards]);

  // Picker computes its own saved-count badges (scoped by current
  // variant filter for wants), so we just thread the raw items
  // through rather than pre-aggregating here.

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
          className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-400 hover:text-gold"
        >
          <ListsIcon className="w-3.5 h-3.5" />
          <span>My Lists</span>
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
          onEscapeKeyDown={e => {
            // In picker mode, Esc should only close the picker and leave
            // the drawer open — the drawer itself is dismissed by another
            // Esc press from the list view.
            if (mode === 'picker') {
              e.preventDefault();
              setMode('list');
            }
          }}
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
            <div className="flex items-center gap-3">
              {totalCount > 0 && (
                <ShareListsButton
                  wantsItems={wants.items}
                  availableItems={available.items}
                />
              )}
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
              {/* Color reservation mirrors the trade panels: Wants lines
                  up with Receiving (blue) — cards the user wants to take
                  in — and Available lines up with Offering (emerald) —
                  cards the user has to give. */}
              <TabTrigger value="wants" count={wantsCount} accent="blue">Wants</TabTrigger>
              <TabTrigger value="available" count={availableCount} accent="emerald">Available</TabTrigger>
            </Tabs.List>

            <Tabs.Content value="wants" className="flex-1 min-h-0 data-[state=inactive]:hidden flex flex-col">
              {mode === 'picker' && tab === 'wants' ? (
                <ListCardPicker
                  listType="wants"
                  allCards={allCards}
                  percentage={percentage}
                  priceMode={priceMode}
                  wants={wants}
                  onPick={(card, ctx) => {
                    // Variant filter (acceptedVariants) drives the saved
                    // restriction. Empty filter → any. Otherwise →
                    // restricted to the filter set.
                    const accepted = ctx.acceptedVariants ?? [];
                    const restriction = accepted.length > 0
                      ? { mode: 'restricted' as const, variants: accepted }
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
                        {sortedWants.map(item => {
                          // Prefer the variant that satisfies the want's
                          // restriction (e.g. Showcase art for a Showcase-
                          // restricted want). Falls back to the family's
                          // Standard rep when no candidates loaded yet.
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
              )}
            </Tabs.Content>

            <Tabs.Content value="available" className="flex-1 min-h-0 data-[state=inactive]:hidden flex flex-col">
              {mode === 'picker' && tab === 'available' ? (
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
                  <AddCardFooter onClick={() => setMode('picker')} accent="emerald" />
                </>
              )}
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const ADD_CARD_ACCENT: Record<'blue' | 'emerald', string> = {
  blue: 'bg-blue-500/10 border-blue-500/30 text-blue-200 hover:bg-blue-500/20 hover:border-blue-500/50',
  emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/20 hover:border-emerald-500/50',
};

function AddCardFooter({ onClick, accent }: { onClick: () => void; accent: 'blue' | 'emerald' }) {
  return (
    <div className="shrink-0 border-t border-space-800 p-3">
      <button
        type="button"
        onClick={onClick}
        className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-colors text-xs font-bold tracking-[0.1em] uppercase ${ADD_CARD_ACCENT[accent]}`}
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add Card
      </button>
    </div>
  );
}

const TAB_ACCENT: Record<'blue' | 'emerald', { text: string; underline: string; badge: string }> = {
  blue: {
    text: 'data-[state=active]:text-blue-300',
    underline: 'data-[state=active]:after:bg-blue-400',
    badge: 'group-data-[state=active]:bg-blue-500/20 group-data-[state=active]:text-blue-200',
  },
  emerald: {
    text: 'data-[state=active]:text-emerald-300',
    underline: 'data-[state=active]:after:bg-emerald-400',
    badge: 'group-data-[state=active]:bg-emerald-500/20 group-data-[state=active]:text-emerald-200',
  },
};

function TabTrigger({
  value,
  count,
  accent,
  children,
}: {
  value: ListTab;
  count: number;
  accent: 'blue' | 'emerald';
  children: React.ReactNode;
}) {
  const a = TAB_ACCENT[accent];
  return (
    <Tabs.Trigger
      value={value}
      className={[
        'group relative flex items-center gap-1.5 px-3 py-2 text-xs font-bold tracking-[0.08em] uppercase rounded-t-md',
        'text-gray-500 hover:text-gray-300 transition-colors',
        a.text,
        'after:content-[""] after:absolute after:bottom-0 after:inset-x-2 after:h-px after:bg-transparent',
        a.underline,
      ].join(' ')}
    >
      {children}
      {count > 0 && (
        <span className={`px-1.5 py-px rounded-full bg-space-700 text-gray-300 text-[10px] font-bold leading-none transition-colors ${a.badge}`}>
          {count}
        </span>
      )}
    </Tabs.Trigger>
  );
}

function ShareListsButton({
  wantsItems,
  availableItems,
}: {
  wantsItems: WantsApi['items'];
  availableItems: AvailableApi['items'];
}) {
  const [linkCopied, setLinkCopied] = useState(false);
  const [showImage, setShowImage] = useState(false);

  // Build the share URL from current location, overlaying ?w=/?a=
  // with the user's lists. Used for both Link copy and Image render.
  const shareUrl = useCallback((): URL => {
    const url = new URL(window.location.href);
    if (wantsItems.length > 0) url.searchParams.set('w', encodeWants(wantsItems));
    else url.searchParams.delete('w');
    if (availableItems.length > 0) url.searchParams.set('a', encodeAvailable(availableItems));
    else url.searchParams.delete('a');
    // List shares default to list-view landing — clear any lingering
    // ?view=trade so the recipient lands on the dedicated /list view.
    url.searchParams.delete('view');
    return url;
  }, [wantsItems, availableItems]);

  const copyLink = useCallback(async () => {
    const url = shareUrl().toString();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [shareUrl]);

  const imageUrl = useCallback(() => {
    const url = shareUrl();
    const params = new URLSearchParams();
    const w = url.searchParams.get('w');
    const a = url.searchParams.get('a');
    if (w) params.set('w', w);
    if (a) params.set('a', a);
    const pct = url.searchParams.get('pct');
    const pm = url.searchParams.get('pm');
    if (pct) params.set('pct', pct);
    if (pm) params.set('pm', pm);
    return `/api/og?${params.toString()}`;
  }, [shareUrl]);

  return (
    <>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={copyLink}
          title="Copy a share link with your lists"
          aria-label="Copy share link"
          className="flex items-center gap-1 px-2 h-7 rounded text-[10px] font-bold uppercase tracking-wide text-gray-400 hover:text-gold hover:bg-gold/10 transition-colors"
        >
          {linkCopied ? (
            <>
              <CheckIcon className="w-3 h-3" />
              Copied
            </>
          ) : (
            <>
              <LinkIcon className="w-3 h-3" />
              Link
            </>
          )}
        </button>
        <button
          type="button"
          onClick={() => setShowImage(true)}
          title="Generate a shareable image of your lists"
          aria-label="Generate share image"
          className="flex items-center gap-1 px-2 h-7 rounded text-[10px] font-bold uppercase tracking-wide bg-gold/10 text-gold hover:bg-gold/20 transition-colors"
        >
          <ImageIcon className="w-3 h-3" />
          Image
        </button>
      </div>
      {showImage && (
        <TradeImageModal imageUrl={imageUrl()} onClose={() => setShowImage(false)} />
      )}
    </>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6.5 8.5l3-3M5 7l-1.5 1.5a2.5 2.5 0 003.5 3.5L8.5 10.5M11 9l1.5-1.5a2.5 2.5 0 00-3.5-3.5L7.5 5.5" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="6" cy="7" r="1" />
      <path d="M2 11l3-3 4 4 2-2 3 3" />
    </svg>
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
