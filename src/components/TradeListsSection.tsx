import { useMemo, useState } from 'react';
import type { CardVariant, PriceMode, TradeCard } from '../types';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import {
  cardImageUrl,
  adjustPrice,
  getCardPrice,
} from '../services/priceService';
import {
  extractVariantLabel,
  variantBadgeColor,
  variantDisplayLabel,
} from '../variants';
import { bestMatchForWant, matchesRestriction } from '../listMatching';

interface TileEntry {
  itemId: string;           // wants/available item id, used as React key
  card: CardVariant;         // card to add when tile is tapped
  remaining: number;         // qty still needed to fulfill the list item
  isPriority?: boolean;      // wants priority flag (gold-bright star)
}

interface TradeListsSectionProps {
  side: 'offering' | 'receiving';
  wants: WantsApi;
  available: AvailableApi;
  /** All cards loaded so far. The section resolves wants/available items
   *  to specific variants for display + add. Items whose card hasn't
   *  loaded yet are skipped silently. */
  byFamilyAll: Map<string, CardVariant[]>;
  byProductId: Map<string, CardVariant>;
  /** Cards already on this trade side. Used to subtract from the
   *  desired qty so each row shows what's still needed; rows disappear
   *  once their item is fully fulfilled. */
  tradeCards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
  onAdd: (card: CardVariant) => void;
}

/**
 * Personal-source picker rendered in the add-card overlay's empty state.
 * - Offering side: pulls from your Available list.
 * - Receiving side: pulls from your Wants list (priority items first).
 *
 * Lives ABOVE search so users see their curated cards before resorting
 * to the broader TCGPlayer search. Hidden as soon as the user types
 * (search results take over). Renders nothing when the relevant list is
 * empty; the existing "type to search" hint then fills the space.
 */
export function TradeListsSection({
  side,
  wants,
  available,
  byFamilyAll,
  byProductId,
  tradeCards,
  percentage,
  priceMode,
  onAdd,
}: TradeListsSectionProps) {
  const isOffering = side === 'offering';

  const tiles = useMemo<TileEntry[]>(() => {
    if (isOffering) {
      return available.items
        .map(item => {
          const card = byProductId.get(item.productId);
          if (!card) return null;
          // Remaining = desired qty minus what's already in this trade
          // side as the exact same productId.
          const inTrade = tradeCards.reduce(
            (sum, tc) => tc.card.productId === item.productId ? sum + tc.qty : sum,
            0,
          );
          const remaining = item.qty - inTrade;
          if (remaining <= 0) return null;
          return { itemId: item.id, card, remaining } as TileEntry;
        })
        .filter((t): t is TileEntry => t !== null);
    }

    // Wants — priority first, then by add order.
    const sorted = [...wants.items].sort((a, b) => {
      const pa = a.isPriority ? 1 : 0;
      const pb = b.isPriority ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return a.addedAt - b.addedAt;
    });

    return sorted
      .map(item => {
        const candidates = byFamilyAll.get(item.familyId) ?? [];
        if (candidates.length === 0) return null;
        const card = bestMatchForWant(item, candidates, priceMode);
        if (!card) return null;
        // Remaining = desired qty minus any trade-side cards from the
        // same family that satisfy the want's restriction.
        const familyProductIds = new Set(candidates.map(c => c.productId).filter((p): p is string => !!p));
        const inTrade = tradeCards.reduce((sum, tc) => {
          if (!tc.card.productId || !familyProductIds.has(tc.card.productId)) return sum;
          if (!matchesRestriction(tc.card, item.restriction)) return sum;
          return sum + tc.qty;
        }, 0);
        const remaining = item.qty - inTrade;
        if (remaining <= 0) return null;
        return {
          itemId: item.id,
          card,
          remaining,
          isPriority: item.isPriority,
        } as TileEntry;
      })
      .filter((t): t is TileEntry => t !== null);
  }, [isOffering, available.items, wants.items, byFamilyAll, byProductId, priceMode, tradeCards]);

  if (tiles.length === 0) return null;

  return (
    <CollapsibleSection
      isOffering={isOffering}
      tiles={tiles}
      percentage={percentage}
      priceMode={priceMode}
      onAdd={onAdd}
    />
  );
}

interface CollapsibleSectionProps {
  isOffering: boolean;
  tiles: TileEntry[];
  percentage: number;
  priceMode: PriceMode;
  onAdd: (card: CardVariant) => void;
}

function CollapsibleSection({ isOffering, tiles, percentage, priceMode, onAdd }: CollapsibleSectionProps) {
  // Default expanded — user collapses when they want search results to
  // dominate. Local state means the choice resets per overlay open,
  // which feels right (each session is a fresh decision).
  const [collapsed, setCollapsed] = useState(false);

  const heading = isOffering ? 'From your Available' : 'From your Wants';
  const accent = isOffering
    ? 'text-emerald-300 border-emerald-500/30'
    : 'text-blue-300 border-blue-500/30';
  const chevron = isOffering ? 'text-emerald-400/80' : 'text-blue-400/80';
  const accentColor = isOffering ? 'emerald' : 'blue';

  return (
    <section className={collapsed ? 'mb-3' : 'mb-6'}>
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        aria-label={collapsed ? `Expand ${heading}` : `Collapse ${heading}`}
        aria-expanded={!collapsed}
        className={`w-full flex items-center gap-2 pb-2 mb-3 border-b ${accent} hover:bg-white/[0.02] active:bg-white/[0.04] transition-colors text-left`}
      >
        <span className={`shrink-0 flex items-center justify-center w-4 h-4 ${chevron}`} aria-hidden>
          <svg
            className={`w-3 h-3 transition-transform ${collapsed ? '-rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
        <span className="text-[10px] font-bold tracking-[0.18em] uppercase">
          {heading}
        </span>
        <span className="text-[10px] text-gray-600">{tiles.length}</span>
      </button>

      {/* Compact list-style rows. Cards in your lists feel like "shortcuts
          to add" rather than mini trade tiles — no card-art frame, no big
          gold badge. Each row is a "to-do": the qty shown is what's
          STILL needed (desired minus already-in-trade), and the row
          disappears once fulfilled. */}
      {!collapsed && (
        <ul className="flex flex-col gap-1.5">
          {tiles.map(({ itemId, card, remaining, isPriority }) => (
            <SourceRow
              key={itemId}
              card={card}
              remaining={remaining}
              isPriority={isPriority}
              percentage={percentage}
              priceMode={priceMode}
              accentColor={accentColor}
              onClick={() => onAdd(card)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface SourceRowProps {
  card: CardVariant;
  remaining: number;
  isPriority?: boolean;
  percentage: number;
  priceMode: PriceMode;
  accentColor: 'emerald' | 'blue';
  onClick: () => void;
}

function SourceRow({
  card,
  remaining,
  isPriority,
  percentage,
  priceMode,
  accentColor,
  onClick,
}: SourceRowProps) {
  const variant = extractVariantLabel(card.name);
  const variantLabel = variantDisplayLabel(variant);
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');
  const display = card.displayName ?? card.name.replace(/\s*\([^)]*\)\s*$/, '');
  const hoverText = accentColor === 'emerald' ? 'group-hover:text-emerald-300' : 'group-hover:text-blue-300';
  const hoverBorder = accentColor === 'emerald' ? 'group-hover:border-emerald-500/40' : 'group-hover:border-blue-500/40';
  const hoverBg = accentColor === 'emerald' ? 'group-hover:bg-emerald-950/15' : 'group-hover:bg-blue-950/15';

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`group w-full flex items-center gap-3 px-2 py-1.5 rounded-md bg-transparent border border-space-800 ${hoverBorder} ${hoverBg} transition-colors text-left active:scale-[0.99]`}
      >
        {/* Thumbnail — small, neutral. Object-cover crops gracefully for
            both portrait and landscape source images so leaders don't
            hijack the row height. */}
        <div className="w-8 h-11 shrink-0 rounded bg-space-900 overflow-hidden border border-space-700">
          {imgUrl ? (
            <img
              src={imgUrl}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
            />
          ) : null}
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            {isPriority && (
              <span className="text-gold-bright shrink-0" aria-label="Priority want" style={{ fontSize: 11, lineHeight: 1 }}>
                ★
              </span>
            )}
            <span className="text-sm text-gray-200 truncate">{display}</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px]">
            {variantLabel && (
              <span className={`leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide ${variantBadgeColor(variant)}`}>
                {variantLabel}
              </span>
            )}
            <span className="text-gray-500" title="Remaining to fulfill">×{remaining}</span>
            {price !== null && (
              <span className="text-gold font-semibold">${price.toFixed(2)}</span>
            )}
          </div>
        </div>

        {/* "Add" hint — plus icon visible always (subtle), brightens on
            hover. Reads as the action affordance. */}
        <span className={`shrink-0 text-gray-600 ${hoverText} transition-colors`} aria-hidden>
          <PlusIcon className="w-4 h-4" />
        </span>
      </button>
    </li>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M8 3V13M3 8H13" />
    </svg>
  );
}
