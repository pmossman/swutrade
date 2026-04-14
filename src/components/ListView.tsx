import { useMemo } from 'react';
import type { CardVariant, PriceMode } from '../types';
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
  isLeaderOrBaseGroup,
} from '../variants';
import { bestMatchForWant } from '../listMatching';
import type { WantsItem } from '../persistence';
import { Logo } from './Logo';
import { BetaBadge } from './BetaBadge';

interface ResolvedTile {
  key: string;
  card: CardVariant;
  qty: number;
  isPriority?: boolean;
  landscape: boolean;
}

interface ListViewProps {
  sharedLists: SharedLists;
  byFamilyAll: Map<string, CardVariant[]>;
  byProductId: Map<string, CardVariant>;
  percentage: number;
  priceMode: PriceMode;
  isAnyLoading: boolean;
  onStartTrade: () => void;
}

/**
 * Full-page rendering of a shared list. Default landing when the
 * URL carries ?w= / ?a= without trade params. Visual browsing
 * surface — every card is a real artifact, not a "tap to add"
 * widget. The primary action is "Start a trade with these," which
 * flips the app into trade mode with the shared lists pre-loaded
 * into the add-card empty state.
 */
export function ListView({
  sharedLists,
  byFamilyAll,
  byProductId,
  percentage,
  priceMode,
  isAnyLoading,
  onStartTrade,
}: ListViewProps) {
  const wantsTiles = useMemo<ResolvedTile[]>(() => {
    return sharedLists.wants
      .map((w, i) => {
        const candidates = byFamilyAll.get(w.familyId) ?? [];
        if (candidates.length === 0) return null;
        // Synthesize a WantsItem so we can reuse bestMatchForWant.
        const synth = { ...w, id: '_', addedAt: 0 } as WantsItem;
        const card = bestMatchForWant(synth, candidates, priceMode);
        if (!card) return null;
        return {
          key: 'w-' + i,
          card,
          qty: w.qty,
          isPriority: w.isPriority,
          landscape: isLeaderOrBaseGroup(candidates),
        } as ResolvedTile;
      })
      .filter((t): t is ResolvedTile => t !== null);
  }, [sharedLists.wants, byFamilyAll, priceMode]);

  const availableTiles = useMemo<ResolvedTile[]>(() => {
    return sharedLists.available
      .map((a, i) => {
        const card = byProductId.get(a.productId);
        if (!card) return null;
        return {
          key: 'a-' + i,
          card,
          qty: a.qty,
          landscape: isLeaderOrBaseGroup([card]),
        } as ResolvedTile;
      })
      .filter((t): t is ResolvedTile => t !== null);
  }, [sharedLists.available, byProductId]);

  const declaredWants = sharedLists.wants.length;
  const declaredAvailable = sharedLists.available.length;
  const resolvedWants = wantsTiles.length;
  const resolvedAvailable = availableTiles.length;

  // If a card in the share URL hasn't loaded yet (rare promo set,
  // pre-build cache, etc.), surface the gap so the recipient knows
  // the view isn't broken — just incomplete.
  const missingWants = declaredWants - resolvedWants;
  const missingAvailable = declaredAvailable - resolvedAvailable;
  const hasMissing = missingWants > 0 || missingAvailable > 0;

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      {/* Top bar — wordmark on the left, primary CTA on the right */}
      <header className="px-3 sm:px-6 pt-3 pb-2 max-w-6xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <h1 className="relative flex items-center select-none shrink-0">
            <Logo className="w-6 h-6 sm:w-7 sm:h-7 shrink-0" />
            <span className="ml-px text-sm sm:text-lg font-bold tracking-[0.1em] sm:tracking-[0.12em] leading-none">
              <span className="text-gray-200 uppercase">SWU</span><span className="text-gold uppercase">Trade</span>
            </span>
            <BetaBadge className="absolute bottom-0 left-7 sm:left-8 translate-y-[calc(100%-2px)]" />
          </h1>
          <div className="ml-auto">
            <button
              type="button"
              onClick={onStartTrade}
              className="flex items-center gap-1.5 px-3 sm:px-4 h-9 rounded-lg bg-gold/15 border border-gold/40 hover:bg-gold/25 hover:border-gold/60 text-gold text-xs sm:text-sm font-bold tracking-wide uppercase transition-colors"
            >
              <span>Start a trade</span>
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </button>
          </div>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">Shared list</span>
          <span className="text-[11px] text-gray-600">
            {resolvedWants > 0 && `${resolvedWants} want${resolvedWants === 1 ? '' : 's'}`}
            {resolvedWants > 0 && resolvedAvailable > 0 && ' · '}
            {resolvedAvailable > 0 && `${resolvedAvailable} available`}
          </span>
        </div>
      </header>

      {hasMissing && !isAnyLoading && (
        <div className="px-3 sm:px-6 max-w-6xl mx-auto w-full">
          <div className="text-[11px] text-amber-300 bg-amber-950/30 border border-amber-500/30 rounded-md px-3 py-2">
            {missingWants + missingAvailable} item(s) in this list aren't available in our database yet — they may be from sets we haven't indexed.
          </div>
        </div>
      )}

      <main className="flex-1 px-3 sm:px-6 pb-8 pt-2 max-w-6xl mx-auto w-full">
        {wantsTiles.length === 0 && availableTiles.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-center text-gray-500 py-20">
            {isAnyLoading
              ? 'Loading card data…'
              : 'No items in this shared list.'}
          </div>
        ) : (
          <div className="space-y-8">
            {wantsTiles.length > 0 && (
              <ListSection
                title="Wants"
                count={wantsTiles.length}
                tone="blue"
                tiles={wantsTiles}
                percentage={percentage}
                priceMode={priceMode}
              />
            )}
            {availableTiles.length > 0 && (
              <ListSection
                title="Available"
                count={availableTiles.length}
                tone="emerald"
                tiles={availableTiles}
                percentage={percentage}
                priceMode={priceMode}
              />
            )}
          </div>
        )}
      </main>

      <footer className="shrink-0 px-3 sm:px-6 pb-4 text-center text-[10px] text-gray-600 max-w-6xl mx-auto w-full">
        <span>Anonymous list shared via SWUTrade · </span>
        <button
          type="button"
          onClick={onStartTrade}
          className="text-gold/80 hover:text-gold underline transition-colors"
        >
          Start a trade with these cards
        </button>
      </footer>
    </div>
  );
}

interface ListSectionProps {
  title: string;
  count: number;
  tone: 'blue' | 'emerald';
  tiles: ResolvedTile[];
  percentage: number;
  priceMode: PriceMode;
}

function ListSection({ title, count, tone, tiles, percentage, priceMode }: ListSectionProps) {
  const accent = tone === 'blue'
    ? 'text-blue-300 border-blue-500/30'
    : 'text-emerald-300 border-emerald-500/30';

  return (
    <section>
      <div className={`flex items-baseline gap-2 pb-2 mb-4 border-b ${accent}`}>
        <span className="text-xs sm:text-sm font-bold tracking-[0.18em] uppercase">
          {title}
        </span>
        <span className="text-[11px] text-gray-600">{count}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
        {tiles.map(tile => (
          <ListTile
            key={tile.key}
            tile={tile}
            percentage={percentage}
            priceMode={priceMode}
          />
        ))}
      </div>
    </section>
  );
}

interface ListTileProps {
  tile: ResolvedTile;
  percentage: number;
  priceMode: PriceMode;
}

function ListTile({ tile, percentage, priceMode }: ListTileProps) {
  const { card, qty, isPriority, landscape } = tile;
  const variant = extractVariantLabel(card.name);
  const variantLabel = variantDisplayLabel(variant);
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');
  const display = card.displayName ?? card.name.replace(/\s*\([^)]*\)\s*$/, '');

  return (
    <div className="relative flex flex-col rounded-lg bg-space-800/60 border border-space-700 overflow-hidden">
      <div className={`${landscape ? 'aspect-[7/5]' : 'aspect-[5/7]'} bg-space-900 overflow-hidden`}>
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={display}
            loading="lazy"
            className="w-full h-full object-contain"
          />
        ) : null}
      </div>
      {qty > 1 && (
        <span className="absolute top-1.5 right-1.5 px-2 py-0.5 rounded-full bg-gold text-space-900 text-[11px] font-bold leading-none shadow">
          ×{qty}
        </span>
      )}
      {isPriority && (
        <span className="absolute top-1.5 left-1.5 text-gold-bright drop-shadow" aria-label="Priority" style={{ fontSize: 16, lineHeight: 1 }}>
          ★
        </span>
      )}
      <div className="px-2 py-1.5 flex flex-col gap-0.5">
        <div className="text-[11px] sm:text-xs text-gray-200 truncate">{display}</div>
        <div className="flex items-center gap-1.5">
          {variantLabel && (
            <span className={`text-[8px] leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide ${variantBadgeColor(variant)}`}>
              {variantLabel}
            </span>
          )}
          {price !== null && (
            <span className="ml-auto text-[10px] text-gold font-semibold">${price.toFixed(2)}</span>
          )}
        </div>
      </div>
    </div>
  );
}
