import { useMemo } from 'react';
import type { CardVariant, PriceMode } from '../types';
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
  isLeaderOrBaseGroup,
} from '../variants';
import { bestMatchForWant } from '../listMatching';

interface TileEntry {
  itemId: string;          // wants/available item id, used as React key
  card: CardVariant;        // card to add when tile is tapped
  qty: number;              // how many are in the user's list
  isPriority?: boolean;     // wants priority flag (gold-bright star)
  landscape: boolean;
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
          // Single-card landscape detection works because isLeader-
          // OrBaseGroup consults the card's cardType when present.
          return {
            itemId: item.id,
            card,
            qty: item.qty,
            landscape: isLeaderOrBaseGroup([card]),
          } as TileEntry;
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
        return {
          itemId: item.id,
          card,
          qty: item.qty,
          isPriority: item.isPriority,
          // Inspect the whole family — a Leader's cheapest matching
          // variant may not itself carry cardType.
          landscape: isLeaderOrBaseGroup(candidates),
        } as TileEntry;
      })
      .filter((t): t is TileEntry => t !== null);
  }, [isOffering, available.items, wants.items, byFamilyAll, byProductId, priceMode]);

  if (tiles.length === 0) return null;

  const heading = isOffering ? 'From your Available' : 'From your Wants';
  const accent = isOffering
    ? 'text-emerald-300 border-emerald-500/30'
    : 'text-blue-300 border-blue-500/30';
  const tileHover = isOffering
    ? 'hover:border-emerald-500/60'
    : 'hover:border-blue-500/60';

  return (
    <section className="mb-6">
      <div className={`flex items-baseline gap-2 pb-2 mb-3 border-b ${accent}`}>
        <span className="text-[10px] font-bold tracking-[0.18em] uppercase">
          {heading}
        </span>
        <span className="text-[10px] text-gray-600">{tiles.length}</span>
      </div>

      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8 gap-3">
        {tiles.map(({ itemId, card, qty, isPriority, landscape }) => (
          <SourceTile
            key={itemId}
            card={card}
            qty={qty}
            isPriority={isPriority}
            landscape={landscape}
            percentage={percentage}
            priceMode={priceMode}
            hoverClass={tileHover}
            onClick={() => onAdd(card)}
          />
        ))}
      </div>
    </section>
  );
}

interface SourceTileProps {
  card: CardVariant;
  qty: number;
  isPriority?: boolean;
  landscape: boolean;
  percentage: number;
  priceMode: PriceMode;
  hoverClass: string;
  onClick: () => void;
}

function SourceTile({
  card,
  qty,
  isPriority,
  landscape,
  percentage,
  priceMode,
  hoverClass,
  onClick,
}: SourceTileProps) {
  const variant = extractVariantLabel(card.name);
  const variantLabel = variantDisplayLabel(variant);
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex flex-col items-stretch rounded-lg bg-space-800/80 border border-space-700 transition-all text-left overflow-hidden active:scale-[0.98] ${hoverClass}`}
    >
      <div className={`${landscape ? 'aspect-[7/5]' : 'aspect-[5/7]'} bg-space-900 overflow-hidden`}>
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={card.name}
            loading="lazy"
            className="w-full h-full object-contain"
          />
        ) : null}
      </div>
      {/* Quantity badge — gold pill in top-right shows "×N" so users see
          how many they have/want of that card. */}
      <span
        className="absolute top-1 right-1 px-1.5 py-0.5 rounded-full bg-gold text-space-900 text-[10px] font-bold leading-none shadow"
        aria-label={`${qty} in list`}
      >
        ×{qty}
      </span>
      {isPriority && (
        // Priority star for wants — gold-bright per palette rules. Sits
        // top-left so it doesn't crowd the qty badge.
        <span
          className="absolute top-1 left-1 text-gold-bright drop-shadow"
          aria-label="Priority want"
          style={{ fontSize: 14, lineHeight: 1 }}
        >
          ★
        </span>
      )}
      <div className="px-1.5 py-1 flex items-center gap-1">
        {variantLabel && (
          <span className={`text-[8px] leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide ${variantBadgeColor(variant)}`}>
            {variantLabel}
          </span>
        )}
        {price !== null && (
          <span className="ml-auto text-[10px] text-gold font-semibold">
            ${price.toFixed(2)}
          </span>
        )}
      </div>
    </button>
  );
}
