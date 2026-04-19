import { useState, useMemo, useCallback, useEffect } from 'react';
import type { TradeCard, CardVariant, PriceMode } from '../types';
import { tradeCardKey } from '../types';
import { adjustPrice, formatPrice, getCardPrice } from '../services/priceService';
import { extractBaseName } from '../variants';
import { bestMatchForWant, matchesRestriction } from '../listMatching';
import type { WantsItem } from '../persistence';
import { useIsMobile } from '../hooks/useMediaQuery';
import type { SelectionFilters } from '../hooks/useSelectionFilters';
import { TradeRow, type ThumbSize } from './TradeRow';
import {
  TradeSearchOverlay,
  type SourceChipConfig,
  type TradeSearchOverlaySeed,
} from './TradeSearchOverlay';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import type { SharedLists } from '../hooks/useSharedLists';
import { cardFamilyId } from '../variants';
import { useCardIndexContext } from '../contexts/CardIndexContext';

interface TradeSideProps {
  label: string;
  cards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
  onAdd: (card: CardVariant) => void;
  onRemove: (key: string) => void;
  onChangeQty: (key: string, delta: number) => void;
  accentColor: 'emerald' | 'blue';
  borderColor: string;
  setCards: Record<string, CardVariant[]>;
  isLoading: boolean;
  onLoadAllSets: () => void;
  // Shared filter state. Lifted to App so both trade sides stay in sync.
  filters: SelectionFilters;
  // Personal-source pickers in the search overlay's empty state pull
  // from these. Offering side surfaces Available; Receiving surfaces
  // Wants. Card indexes (byFamilyAll / byProductId) come from
  // CardIndexContext now, so they don't need to be prop-drilled
  // alongside the personal-list APIs.
  wants: WantsApi;
  available: AvailableApi;
  sharedLists: SharedLists | null;
  /** When true, the card list collapses and the header shrinks to show
   *  just the label + count + total, with a chevron to re-expand. */
  collapsed: boolean;
  /** Only provided on mobile — desktop layout shows both panels side
   *  by side so collapsing offers no space win. */
  onToggleCollapse?: () => void;
  /** Optional explicit flex-basis percentage (0-1). When set, overrides
   *  the default auto-sizing — used by the mobile panel divider. */
  flexBasis?: number;
  /** One-shot signal from the shared-list landing: auto-open the
   *  search overlay with the "They want" source chip active. */
  autoOpenSharedLink?: boolean;
  onConsumeAutoOpen?: () => void;
  /** Phase-4 community rollup. For Offering: familyIds other enrolled
   *  guild members want (we scope to cards the viewer has available).
   *  For Receiving: productIds other enrolled members have available
   *  (we scope to cards matching the viewer's wants). Empty lists are
   *  the baseline for non-signed-in users or viewers with no enrolled
   *  guilds — the chip just doesn't render. */
  communityWantFamilyIds?: readonly string[];
  communityAvailableProductIds?: readonly string[];
  /** When true, opening the search overlay auto-activates the "theirs"
   *  source chip — used in propose mode so the first thing the user
   *  sees is the overlap with their counterpart, not the whole catalog.
   *  Manual chip toggling afterward stays the user's choice. */
  autoScopeToTheirs?: boolean;
  /** Counterpart handle (propose or shared-list context). Threaded
   *  into TradeSearchOverlay so the picker header can show "for
   *  @alice" — avoids the full-screen overlay feeling disconnected
   *  from its parent flow. */
  counterpartHandle?: string | null;
  /** When true, skip the in-panel header strip (label + count +
   *  total). Used in the tabbed layout where the tab bar above the
   *  panel already carries that information — rendering both reads
   *  as duplicated chrome. */
  headerless?: boolean;
}

const headerColors: Record<string, string> = {
  emerald: 'border-emerald-500/30 text-emerald-300',
  blue: 'border-blue-500/30 text-blue-300',
};

// Vertical "saber bar" on the left edge of each panel — identifies the side
// at a glance. Colored from bright core → muted tail with a soft glow,
// mimicking a lightsaber blade.
const saberBarColors: Record<string, string> = {
  emerald: 'bg-gradient-to-b from-emerald-300 via-emerald-500 to-emerald-700 shadow-[0_0_12px_rgba(52,211,153,0.55)]',
  blue: 'bg-gradient-to-b from-blue-300 via-blue-500 to-blue-700 shadow-[0_0_12px_rgba(96,165,250,0.55)]',
};

// Collapse chevron — colored to match the side accent so it reads as
// part of the panel chrome, not a generic system control.
const chevronColors: Record<string, string> = {
  emerald: 'text-emerald-400/80',
  blue: 'text-blue-400/80',
};

// Pick thumbnail size based on total card entries. On mobile we cap
// at `md` since even a single card at `lg` eats most of the viewport
// and doesn't leave room for the other panel.
function thumbSize(cardCount: number, isMobile: boolean): ThumbSize {
  if (isMobile) {
    if (cardCount <= 4) return 'md';
    if (cardCount <= 10) return 'sm';
    return 'xs';
  }
  if (cardCount <= 2) return 'lg';
  if (cardCount <= 4) return 'md';
  if (cardCount <= 8) return 'sm';
  return 'xs';
}

export function TradeSide({
  label,
  cards,
  percentage,
  priceMode,
  onAdd,
  onRemove,
  onChangeQty,
  accentColor,
  borderColor,
  setCards,
  isLoading,
  onLoadAllSets,
  wants,
  available,
  sharedLists,
  filters,
  collapsed,
  onToggleCollapse,
  flexBasis,
  autoOpenSharedLink,
  onConsumeAutoOpen,
  communityWantFamilyIds,
  communityAvailableProductIds,
  autoScopeToTheirs,
  counterpartHandle,
  headerless,
}: TradeSideProps) {
  const { byFamilyAll, byProductId } = useCardIndexContext();
  const isMobile = useIsMobile();
  const isOffering = accentColor === 'emerald';
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [seed, setSeed] = useState<TradeSearchOverlaySeed | null>(null);

  const allCards = useMemo(() => Object.values(setCards).flat(), [setCards]);

  // Source-chip card pools. Qty-aware: only counts items still pending
  // after what's already been added to this side of the trade, so chips
  // auto-empty once their inventory is spoken for.
  const { mineCards, theirsCards } = useMemo(() => {
    const mine: CardVariant[] = [];
    const theirs: CardVariant[] = [];
    if (isOffering) {
      for (const item of available.items) {
        const card = byProductId.get(item.productId);
        if (!card) continue;
        const inTrade = cards.reduce((s, tc) => tc.card.productId === item.productId ? s + tc.qty : s, 0);
        if (item.qty - inTrade > 0) mine.push(card);
      }
      if (sharedLists) {
        for (const w of sharedLists.wants) {
          const candidates = byFamilyAll.get(w.familyId) ?? [];
          if (candidates.length === 0) continue;
          const synth: WantsItem = { ...w, id: '_', addedAt: 0 };
          const match = bestMatchForWant(synth, candidates, priceMode);
          if (!match) continue;
          const fids = new Set(candidates.map(c => c.productId).filter((p): p is string => !!p));
          const inTrade = cards.reduce((s, tc) => {
            if (!tc.card.productId || !fids.has(tc.card.productId)) return s;
            if (!matchesRestriction(tc.card, w.restriction)) return s;
            return s + tc.qty;
          }, 0);
          if (w.qty - inTrade > 0) theirs.push(match);
        }
      }
    } else {
      // Receiving side
      for (const item of wants.items) {
        const candidates = byFamilyAll.get(item.familyId) ?? [];
        if (candidates.length === 0) continue;
        const match = bestMatchForWant(item, candidates, priceMode);
        if (!match) continue;
        const fids = new Set(candidates.map(c => c.productId).filter((p): p is string => !!p));
        const inTrade = cards.reduce((s, tc) => {
          if (!tc.card.productId || !fids.has(tc.card.productId)) return s;
          if (!matchesRestriction(tc.card, item.restriction)) return s;
          return s + tc.qty;
        }, 0);
        if (item.qty - inTrade > 0) mine.push(match);
      }
      if (sharedLists) {
        for (const a of sharedLists.available) {
          const card = byProductId.get(a.productId);
          if (!card) continue;
          const inTrade = cards.reduce((s, tc) => tc.card.productId === a.productId ? s + tc.qty : s, 0);
          if (a.qty - inTrade > 0) theirs.push(card);
        }
      }
    }
    return { mineCards: mine, theirsCards: theirs };
  }, [isOffering, available.items, wants.items, sharedLists, byFamilyAll, byProductId, cards, priceMode]);

  // Overlap chip — the intersection of the two sides' lists: cards
  // the viewer could specifically trade with the counterpart. Exactly
  // what the matchmaker's offering/receiving pool computes, surfaced
  // as a pickable chip so users can see (and work from) the match
  // pool directly instead of discovering it only when they click
  // Suggest. Gated on `sharedLists` — this chip only makes sense in
  // propose or shared-list context, never on the home editor.
  const overlapCards = useMemo<CardVariant[]>(() => {
    if (!sharedLists) return [];
    if (isOffering) {
      // Their wants ∩ my available (qty-aware).
      const wantByFamily = new Map<string, typeof sharedLists.wants[number]>();
      for (const w of sharedLists.wants) wantByFamily.set(w.familyId, w);
      const out: CardVariant[] = [];
      for (const item of available.items) {
        const card = byProductId.get(item.productId);
        if (!card) continue;
        const want = wantByFamily.get(cardFamilyId(card));
        if (!want) continue;
        if (!matchesRestriction(card, want.restriction)) continue;
        const inTrade = cards.reduce(
          (s, tc) => tc.card.productId === item.productId ? s + tc.qty : s,
          0,
        );
        if (item.qty - inTrade > 0) out.push(card);
      }
      return out;
    }
    // Receiving side: my wants ∩ their available (qty-aware).
    const myWantByFamily = new Map<string, typeof wants.items[number]>();
    for (const w of wants.items) myWantByFamily.set(w.familyId, w);
    const out: CardVariant[] = [];
    for (const a of sharedLists.available) {
      const card = byProductId.get(a.productId);
      if (!card) continue;
      const want = myWantByFamily.get(cardFamilyId(card));
      if (!want) continue;
      if (!matchesRestriction(card, want.restriction)) continue;
      const inTrade = cards.reduce(
        (s, tc) => tc.card.productId === a.productId ? s + tc.qty : s,
        0,
      );
      if (a.qty - inTrade > 0) out.push(card);
    }
    return out;
  }, [sharedLists, isOffering, available.items, wants.items, byProductId, cards]);

  // Community chip — cards that other members of the viewer's
  // enrolled Discord guilds want or have available, intersected with
  // the viewer's own inventory/wishlist so the chip surfaces
  // actionable matches instead of a firehose.
  //   Offering side: familyIds community wants ∩ my available → give
  //                  the viewer a "here's what you could offload" pool.
  //   Receiving side: productIds community has ∩ my wants → "here's
  //                   what you could pick up" pool.
  const communityCards = useMemo<CardVariant[]>(() => {
    if (isOffering) {
      if (!communityWantFamilyIds || communityWantFamilyIds.length === 0) return [];
      const wanted = new Set(communityWantFamilyIds);
      const out: CardVariant[] = [];
      for (const item of available.items) {
        const card = byProductId.get(item.productId);
        if (!card) continue;
        if (!wanted.has(cardFamilyId(card))) continue;
        const inTrade = cards.reduce(
          (s, tc) => tc.card.productId === item.productId ? s + tc.qty : s,
          0,
        );
        if (item.qty - inTrade > 0) out.push(card);
      }
      return out;
    }
    // Receiving side: pick up community-available cards matching my wants.
    if (!communityAvailableProductIds || communityAvailableProductIds.length === 0) return [];
    const myWantFamilies = new Map<string, typeof wants.items[number]>();
    for (const w of wants.items) myWantFamilies.set(w.familyId, w);
    const out: CardVariant[] = [];
    for (const productId of communityAvailableProductIds) {
      const card = byProductId.get(productId);
      if (!card) continue;
      const want = myWantFamilies.get(cardFamilyId(card));
      if (!want) continue;
      if (!matchesRestriction(card, want.restriction)) continue;
      const inTrade = cards.reduce(
        (s, tc) => tc.card.productId === productId ? s + tc.qty : s,
        0,
      );
      if (want.qty - inTrade > 0) out.push(card);
    }
    return out;
  }, [
    isOffering,
    communityWantFamilyIds,
    communityAvailableProductIds,
    available.items,
    wants.items,
    byProductId,
    cards,
  ]);

  const sourceChips = useMemo<SourceChipConfig[]>(() => {
    const chips: SourceChipConfig[] = [];
    // Overlap chip goes FIRST when there's a counterpart — it's the
    // "where do I start" default. `alwaysVisible` keeps the chip
    // rendered at 0 cards because "0" is itself a useful signal
    // ("no overlap — go look at what they want instead").
    if (sharedLists) {
      chips.push({
        id: 'overlap',
        // Side-specific label avoids the jargon of "Overlap". Each
        // side reads as a direct answer to "what should I look at?"
        label: isOffering ? 'Their wants you have' : 'Yours they have',
        cards: overlapCards,
        alwaysVisible: true,
      });
    }
    chips.push(
      {
        id: 'mine',
        label: isOffering ? 'My available' : 'My wants',
        cards: mineCards,
      },
      {
        id: 'theirs',
        label: isOffering ? 'They want' : 'They have',
        cards: theirsCards,
      },
    );
    // Community chip is about the generic guild rollup — off-topic
    // when the user is already zoomed in on one specific counterpart.
    // Hidden entirely in propose / shared-list contexts.
    if (!sharedLists && communityCards.length > 0) {
      chips.push({
        id: 'community',
        label: isOffering ? 'Community wants' : 'Community has',
        cards: communityCards,
      });
    }
    return chips;
  }, [isOffering, sharedLists, overlapCards, mineCards, theirsCards, communityCards]);

  // Opening the overlay from the panel's Add-Card affordances. In
  // propose mode the cascade is: overlap first (tightest match pool),
  // theirs second (broader — lets user discover what to source or
  // negotiate), no chip if both are empty (show the full catalog so
  // the user isn't stranded in an empty view).
  const openOverlay = useCallback(() => {
    if (autoScopeToTheirs) {
      if (overlapCards.length > 0) setSeed({ activeChips: ['overlap'] });
      else if (theirsCards.length > 0) setSeed({ activeChips: ['theirs'] });
    }
    setOverlayOpen(true);
  }, [autoScopeToTheirs, overlapCards.length, theirsCards.length]);

  // Swap-variant handler for TradeRow kebab — seeds the overlay with
  // the card's basename so the picker shows every printing of that card.
  const handleReplace = useCallback((card: CardVariant) => {
    onLoadAllSets();
    setSeed({ query: extractBaseName(card.name) });
    setOverlayOpen(true);
  }, [onLoadAllSets]);

  // Shared-list handoff: auto-open with the "they want" chip active
  // so the Offering-side picker lands straight on the sender's wants.
  useEffect(() => {
    if (!autoOpenSharedLink) return;
    setSeed({ activeChips: ['theirs'] });
    setOverlayOpen(true);
    onConsumeAutoOpen?.();
  }, [autoOpenSharedLink, onConsumeAutoOpen]);

  const handleDismissOverlay = useCallback(() => {
    setOverlayOpen(false);
  }, []);

  const handleSeedConsumed = useCallback(() => {
    setSeed(null);
  }, []);

  const total = cards.reduce((sum, tc) => {
    const adj = adjustPrice(getCardPrice(tc.card, priceMode), percentage);
    return sum + (adj ?? 0) * tc.qty;
  }, 0);

  const hdr = headerColors[accentColor];
  const tSize = thumbSize(cards.length, isMobile);

  return (
    <>
      <TradeSearchOverlay
        open={overlayOpen}
        onDismiss={handleDismissOverlay}
        label={label}
        accentColor={accentColor}
        counterpartHandle={counterpartHandle}
        allCards={allCards}
        isLoading={isLoading}
        filters={filters}
        sourceChips={sourceChips}
        cards={cards}
        percentage={percentage}
        priceMode={priceMode}
        onAdd={onAdd}
        onChangeQty={onChangeQty}
        onRemove={onRemove}
        seed={seed}
        onSeedConsumed={handleSeedConsumed}
      />
      <div
        className={`relative bg-space-800 rounded-xl border ${borderColor} overflow-hidden flex flex-col ${collapsed ? 'flex-none' : 'min-h-0'} ${collapsed || flexBasis !== undefined ? '' : 'flex-auto'}`}
        style={!collapsed && flexBasis !== undefined ? { flex: `0 1 ${flexBasis * 100}%` } : undefined}
      >
        {/* Saber-bar side accent */}
        <div className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full ${saberBarColors[accentColor]}`} aria-hidden />
        {/* Header — entire row toggles collapse on tap when collapse is
            available (mobile). The chevron is just a visual indicator,
            colored to match the side's accent so it reads as part of
            the panel rather than a generic gray button.
            Suppressed in tabbed mode (`headerless`) because the tab
            bar above already carries label + count + total. */}
        {!headerless && (() => {
          const headerContent = (
            <>
              {onToggleCollapse && (
                <span className={`shrink-0 flex items-center justify-center w-5 h-5 ${chevronColors[accentColor]}`} aria-hidden>
                  <svg
                    className={`w-4 h-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                  </svg>
                </span>
              )}
              <span className="swu-display text-xs sm:text-sm">{label}</span>
              {cards.length > 0 && (
                <span className="text-[11px] tabular-nums text-gray-400 font-medium">
                  · {cards.length} card{cards.length === 1 ? '' : 's'}
                </span>
              )}
              <span className="flex-1" aria-hidden />
              <span className="flex items-baseline gap-1">
                <span className="text-[9px] uppercase tracking-widest text-gray-500 font-semibold">Total</span>
                <span className="font-bold tabular-nums text-gray-100">{formatPrice(total)}</span>
              </span>
            </>
          );
          const headerClass = `flex items-center gap-2 px-4 py-1.5 ${collapsed ? '' : 'border-b border-space-600'} shrink-0 ${hdr}`;
          return onToggleCollapse ? (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
              aria-expanded={!collapsed}
              className={`${headerClass} w-full text-left hover:bg-white/[0.02] active:bg-white/[0.04] transition-colors`}
            >
              {headerContent}
            </button>
          ) : (
            <div className={headerClass}>{headerContent}</div>
          );
        })()}


        {/* Card list sits above the sticky Add Card footer below. */}
        <div className={`flex-1 min-h-0 overflow-y-auto flex flex-col ${collapsed ? 'hidden' : ''}`}>
          {cards.length === 0 ? (
            <AddCardsTile
              label={label}
              accentColor={accentColor}
              onOpen={openOverlay}
              hint={
                counterpartHandle && overlapCards.length > 0
                  ? 'Or tap ✨ Suggest a match above'
                  : undefined
              }
            />
          ) : (
            <div className="divide-y divide-space-700">
              {cards.map(tc => {
                const key = tradeCardKey(tc.card);
                return (
                  <TradeRow
                    key={key}
                    card={tc.card}
                    qty={tc.qty}
                    percentage={percentage}
                    priceMode={priceMode}
                    size={tSize}
                    accentColor={accentColor}
                    onChangeQty={delta => onChangeQty(key, delta)}
                    onRemove={() => onRemove(key)}
                    onReplace={() => handleReplace(tc.card)}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Sticky Add Card footer — reads as the natural "next step" after
            the card list. Hidden when collapsed (nothing to append to) or
            when empty (AddCardsTile above is already the CTA). */}
        {!collapsed && cards.length > 0 && (
          <button
            type="button"
            onClick={openOverlay}
            className={`flex items-center justify-center gap-1.5 py-1.5 border-t border-space-600 text-xs font-semibold transition-colors shrink-0 ${
              accentColor === 'blue'
                ? 'bg-blue-900/30 hover:bg-blue-800/50 text-blue-200'
                : 'bg-emerald-900/30 hover:bg-emerald-800/50 text-emerald-200'
            }`}
            aria-label={`Add cards to ${label}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add card
          </button>
        )}
      </div>
    </>
  );
}

// Add-cards affordance that sits at the end of the card list. When the
// panel is empty it fills the space as a primary CTA.
function AddCardsTile({
  label,
  accentColor,
  onOpen,
  hint,
}: {
  label: string;
  accentColor: 'emerald' | 'blue';
  onOpen: () => void;
  /** Optional second line rendered beneath the "Add cards" CTA —
   *  used in propose mode to point at the ✨ Suggest button above
   *  so undecided users know an auto-fill option exists. */
  hint?: string;
}) {
  const accentText = accentColor === 'emerald' ? 'text-emerald-300' : 'text-blue-300';
  const accentHoverBorder = accentColor === 'emerald' ? 'hover:border-emerald-500/50' : 'hover:border-blue-500/50';
  const accentHoverBg = accentColor === 'emerald' ? 'hover:bg-emerald-950/20' : 'hover:bg-blue-950/20';
  const accentIcon = accentColor === 'emerald' ? 'group-hover:text-emerald-300' : 'group-hover:text-blue-300';

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex-1 m-3 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-space-700 ${accentHoverBorder} ${accentHoverBg} text-gray-500 transition-colors cursor-pointer px-4 py-8`}
    >
      <svg className={`w-8 h-8 text-space-600 ${accentIcon} transition-colors`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
      </svg>
      <div className="text-center">
        <div className={`text-sm font-semibold ${accentText}`}>Add cards to {label}</div>
        {hint && (
          <div className="text-[11px] text-gray-500 mt-1">{hint}</div>
        )}
      </div>
    </button>
  );
}
