import { useMemo, useState } from 'react';
import type { CardVariant, PriceMode, TradeCard } from '../types';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import type { SharedLists } from '../hooks/useSharedLists';
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
import type { WantsItem } from '../persistence';

interface TileEntry {
  itemId: string;
  card: CardVariant;
  remaining: number;
  isPriority?: boolean;
}

type Tone = 'emerald' | 'blue' | 'gold';

interface TradeListsSectionProps {
  side: 'offering' | 'receiving';
  wants: WantsApi;
  available: AvailableApi;
  /** Optional sender lists from a ?w=&a= URL. Renders as a second
   *  section so the recipient can see the sender's relevant cards
   *  alongside their own. */
  sharedLists: SharedLists | null;
  byFamilyAll: Map<string, CardVariant[]>;
  byProductId: Map<string, CardVariant>;
  tradeCards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
  onAdd: (card: CardVariant) => void;
}

export function TradeListsSection({
  side,
  wants,
  available,
  sharedLists,
  byFamilyAll,
  byProductId,
  tradeCards,
  percentage,
  priceMode,
  onAdd,
}: TradeListsSectionProps) {
  const isOffering = side === 'offering';

  // User's own list — Available on Offering side, Wants on Receiving.
  const primaryTiles = useMemo<TileEntry[]>(() => {
    if (isOffering) {
      return available.items
        .map(item => {
          const card = byProductId.get(item.productId);
          if (!card) return null;
          const inTrade = countInTradeByProduct(tradeCards, item.productId);
          const remaining = item.qty - inTrade;
          if (remaining <= 0) return null;
          return { itemId: item.id, card, remaining } as TileEntry;
        })
        .filter((t): t is TileEntry => t !== null);
    }
    const sorted = [...wants.items].sort((a, b) => {
      const pa = a.isPriority ? 1 : 0;
      const pb = b.isPriority ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return a.addedAt - b.addedAt;
    });
    return sorted
      .map(item => buildWantTile(item, byFamilyAll, tradeCards, priceMode))
      .filter((t): t is TileEntry => t !== null);
  }, [isOffering, available.items, wants.items, byFamilyAll, byProductId, priceMode, tradeCards]);

  // Sender's relevant list — sender's Wants on Offering side (cards
  // they want from us), sender's Available on Receiving side (cards
  // they have to give us).
  const sharedTiles = useMemo<TileEntry[]>(() => {
    if (!sharedLists) return [];
    if (isOffering) {
      return sharedLists.wants
        .map((w, i) => {
          // Reuse the wants tile builder; sender wants don't carry an
          // id so we synthesize one for React keys.
          const tile = buildWantTile(
            { ...w, id: 'shared-w-' + i, addedAt: 0 } as WantsItem,
            byFamilyAll,
            tradeCards,
            priceMode,
          );
          return tile ? { ...tile, itemId: 'shared-w-' + w.familyId + '-' + i } : null;
        })
        .filter((t): t is TileEntry => t !== null);
    }
    return sharedLists.available
      .map((a, i) => {
        const card = byProductId.get(a.productId);
        if (!card) return null;
        const inTrade = countInTradeByProduct(tradeCards, a.productId);
        const remaining = a.qty - inTrade;
        if (remaining <= 0) return null;
        return {
          itemId: 'shared-a-' + a.productId + '-' + i,
          card,
          remaining,
        } as TileEntry;
      })
      .filter((t): t is TileEntry => t !== null);
  }, [sharedLists, isOffering, byFamilyAll, byProductId, priceMode, tradeCards]);

  if (primaryTiles.length === 0 && sharedTiles.length === 0) return null;

  const primaryHeading = isOffering ? 'From your Available' : 'From your Wants';
  const sharedHeading = isOffering ? 'From the shared link · They want' : 'From the shared link · They have';

  return (
    <>
      {primaryTiles.length > 0 && (
        <CollapsibleSection
          tiles={primaryTiles}
          heading={primaryHeading}
          tone={isOffering ? 'emerald' : 'blue'}
          percentage={percentage}
          priceMode={priceMode}
          onAdd={onAdd}
        />
      )}
      {sharedTiles.length > 0 && (
        <CollapsibleSection
          tiles={sharedTiles}
          heading={sharedHeading}
          tone="gold"
          percentage={percentage}
          priceMode={priceMode}
          onAdd={onAdd}
        />
      )}
    </>
  );
}

function buildWantTile(
  item: WantsItem,
  byFamilyAll: Map<string, CardVariant[]>,
  tradeCards: TradeCard[],
  priceMode: PriceMode,
): TileEntry | null {
  const candidates = byFamilyAll.get(item.familyId) ?? [];
  if (candidates.length === 0) return null;
  const card = bestMatchForWant(item, candidates, priceMode);
  if (!card) return null;
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
  };
}

function countInTradeByProduct(tradeCards: TradeCard[], productId: string): number {
  return tradeCards.reduce(
    (sum, tc) => tc.card.productId === productId ? sum + tc.qty : sum,
    0,
  );
}

interface CollapsibleSectionProps {
  tiles: TileEntry[];
  heading: string;
  tone: Tone;
  percentage: number;
  priceMode: PriceMode;
  onAdd: (card: CardVariant) => void;
}

function CollapsibleSection({ tiles, heading, tone, percentage, priceMode, onAdd }: CollapsibleSectionProps) {
  const [collapsed, setCollapsed] = useState(false);

  const accent = TONE_HEADER[tone];
  const chevron = TONE_CHEVRON[tone];

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
              tone={tone}
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
  tone: Tone;
  onClick: () => void;
}

function SourceRow({
  card,
  remaining,
  isPriority,
  percentage,
  priceMode,
  tone,
  onClick,
}: SourceRowProps) {
  const variant = extractVariantLabel(card.name);
  const variantLabel = variantDisplayLabel(variant);
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');
  const display = card.displayName ?? card.name.replace(/\s*\([^)]*\)\s*$/, '');
  const hover = TONE_HOVER[tone];

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`group w-full flex items-center gap-3 px-2 py-1.5 rounded-md bg-transparent border border-space-800 ${hover.border} ${hover.bg} transition-colors text-left active:scale-[0.99]`}
      >
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

        <span className={`shrink-0 text-gray-600 ${hover.text} transition-colors`} aria-hidden>
          <PlusIcon className="w-4 h-4" />
        </span>
      </button>
    </li>
  );
}

const TONE_HEADER: Record<Tone, string> = {
  emerald: 'text-emerald-300 border-emerald-500/30',
  blue:    'text-blue-300 border-blue-500/30',
  gold:    'text-gold border-gold/30',
};

const TONE_CHEVRON: Record<Tone, string> = {
  emerald: 'text-emerald-400/80',
  blue:    'text-blue-400/80',
  gold:    'text-gold/80',
};

const TONE_HOVER: Record<Tone, { border: string; bg: string; text: string }> = {
  emerald: { border: 'group-hover:border-emerald-500/40', bg: 'group-hover:bg-emerald-950/15', text: 'group-hover:text-emerald-300' },
  blue:    { border: 'group-hover:border-blue-500/40',    bg: 'group-hover:bg-blue-950/15',    text: 'group-hover:text-blue-300' },
  gold:    { border: 'group-hover:border-gold/40',        bg: 'group-hover:bg-gold/5',         text: 'group-hover:text-gold' },
};

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M8 3V13M3 8H13" />
    </svg>
  );
}
