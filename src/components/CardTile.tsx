import { useState, useCallback } from 'react';
import type { CardVariant, PriceMode } from '../types';
import { adjustPrice, cardImageUrl, formatPrice, getCardPrice, getAltPrice } from '../services/priceService';
import { extractVariantLabel, variantBadgeColor } from '../variants';
import { QtyAdjuster } from './ui/QtyAdjuster';

export interface CardTileBadge {
  text: string;
  /** Tailwind class string controlling the pill's bg + text colour. */
  colorClass: string;
}

interface CardTileProps {
  card: CardVariant;
  qty: number;
  percentage: number;
  priceMode: PriceMode;
  /** Side / surface accent. 'gold' for list surfaces (wishlist,
   *  binder, signals, family-mode picker tiles). 'emerald' / 'blue'
   *  for trade-builder offering / receiving. */
  accent: 'gold' | 'emerald' | 'blue';
  /** If true, render at landscape (7:5) aspect — set by parent for
   *  leader/base card groups. Overrides image-load detection. */
  landscape?: boolean;
  /** Pill row above the price. When omitted, the tile renders the
   *  card's intrinsic variant ("Standard", "Hyperspace", …) — the
   *  trade-builder default. Family-mode picker tiles override with
   *  an "Any" pill (or the active filter selection) so the user
   *  sees what a tap will actually save. */
  badge?: CardTileBadge[] | null;
  /** Verb-target string baked into the aria-label so screen readers
   *  + e2e tests can disambiguate which surface the click acts on
   *  ("Add Luke to trade" vs "Add Luke to list"). Defaults to "trade"
   *  to preserve the trade-builder's prior label. */
  actionTarget?: string;
  onAdd: (card: CardVariant) => void;
  onDecrement: (card: CardVariant) => void;
}

const accentBorderClass: Record<'gold' | 'emerald' | 'blue', string> = {
  gold: 'border-gold/50 shadow-[0_0_0_1px_rgba(245,166,35,0.25)]',
  emerald: 'border-emerald-500/50 shadow-[0_0_0_1px_rgba(52,211,153,0.25)]',
  blue: 'border-blue-500/50 shadow-[0_0_0_1px_rgba(96,165,250,0.25)]',
};

// The whole tile is the "add" button. Every click adds one. A qty badge
// shows how many are already in the trade; a hover-revealed − button lets
// the user walk the count back down without jumping to the trade panel.
// Ext-link to TCGPlayer sits on the image but swallows clicks.
export function CardTile({
  card,
  qty,
  percentage,
  priceMode,
  accent,
  landscape = false,
  badge,
  actionTarget = 'trade',
  onAdd,
  onDecrement,
}: CardTileProps) {
  const [imgErrored, setImgErrored] = useState(false);
  const [pulsing, setPulsing] = useState(false);
  // Landscape (leader/base) orientation is authoritative from the parent
  // via the `landscape` prop; we keep a local fallback detector for
  // callers that don't pass the prop.
  const [isLandscapeDetected, setIsLandscapeDetected] = useState(false);
  const isLandscape = landscape || isLandscapeDetected;
  const variant = extractVariantLabel(card.name);
  const unitPrice = adjustPrice(getCardPrice(card, priceMode), percentage);
  const altUnitPrice = adjustPrice(getAltPrice(card, priceMode), percentage);
  const src = cardImageUrl(card.productId);

  const marketRaw = getCardPrice(card, 'market');
  const lowRaw = getCardPrice(card, 'low');
  const spreadDollar = (marketRaw !== null && lowRaw !== null) ? marketRaw - lowRaw : null;
  const spreadPct = (marketRaw !== null && lowRaw !== null && marketRaw > 0)
    ? (marketRaw - lowRaw) / marketRaw
    : null;
  // Require BOTH a meaningful ratio AND a meaningful dollar gap. A card
  // that goes from $0.30 → $0.20 is a 33% spread but a 10-cent difference
  // — nobody cares. The Δ pill is for trades where the Mkt/Low choice
  // actually moves real money.
  const spreadHigh = spreadPct !== null && spreadPct >= 0.25 && (spreadDollar ?? 0) >= 0.5;

  const inTrade = qty > 0;

  const handleAdd = useCallback(() => {
    setPulsing(true);
    onAdd(card);
    setTimeout(() => setPulsing(false), 200);
  }, [card, onAdd]);

  const handleImageClick = useCallback((e: React.MouseEvent) => {
    // Clicking the image adds to trade — the whole tile is the button.
    // TCGPlayer link lives on trade-row cards only; keeping search-tile
    // art clean of overlay icons.
    e.stopPropagation();
    handleAdd();
  }, [handleAdd]);

  const handleKeyActivate = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleAdd();
    }
  }, [handleAdd]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleAdd}
      onKeyDown={handleKeyActivate}
      aria-label={`Add ${card.name} (${variant}) to ${actionTarget}`}
      // Each base-card group renders in its own grid with column counts
      // tuned to the card orientation, so a landscape tile naturally
      // gets a wider slot and equal visual weight to a portrait tile in
      // its own group — no col-span hacks, no cap-width gutters.
      className={`group relative flex flex-col text-left bg-space-700/40 rounded-lg overflow-hidden border transition-all
        ${inTrade ? accentBorderClass[accent] : 'border-space-600 hover:border-space-500'}
        hover:bg-space-700/70 active:scale-[0.98] cursor-pointer
        focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60
        ${pulsing ? 'animate-tile-add' : ''}
      `}
    >
      {/* Image frame — aspect flips to landscape when a leader loads */}
      <div
        className={`relative w-full ${isLandscape ? 'aspect-[7/5]' : 'aspect-[5/7]'} bg-space-800 overflow-hidden`}
        onClick={handleImageClick}
      >
        {src && !imgErrored ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setImgErrored(true)}
            onLoad={e => {
              const img = e.currentTarget;
              if (img.naturalWidth > img.naturalHeight) setIsLandscapeDetected(true);
            }}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-2xl">?</div>
        )}
      </div>

      {/* Metadata strip — stays tight regardless of tile width.
          Pill row defaults to the tile's intrinsic variant (the
          trade-builder default); callers can override via `badge`
          to surface "Any" / "filter selection" style pills for
          family-mode picker tiles. */}
      <div className="px-2 py-1.5">
        <div className="flex items-center justify-between gap-1 mb-1 min-h-[20px]">
          <div className="flex items-center gap-1 flex-wrap min-w-0">
            {badge !== undefined ? (
              badge?.map((b, i) => (
                <span
                  key={`${b.text}-${i}`}
                  className={`text-[9px] leading-none px-1.5 py-0.5 rounded font-medium ${b.colorClass}`}
                >
                  {b.text}
                </span>
              ))
            ) : (
              <span className={`text-[9px] leading-none px-1.5 py-0.5 rounded font-medium ${variantBadgeColor(variant)}`}>
                {variant}
              </span>
            )}
            {spreadHigh && spreadPct !== null && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 text-[9px] font-semibold leading-none"
                title={`Wide spread: Market $${(marketRaw ?? 0).toFixed(2)} vs Low $${(lowRaw ?? 0).toFixed(2)}`}
              >
                Δ{Math.round(spreadPct * 100)}%
              </span>
            )}
          </div>
          {inTrade && (
            <QtyAdjuster
              variant="pill"
              accent={accent}
              size="md"
              qty={qty}
              itemName={card.name}
              onDecrement={() => onDecrement(card)}
            />
          )}
        </div>
        <div className="flex items-baseline gap-1 leading-tight">
          <span className="text-[9px] uppercase tracking-wide text-gray-500">
            {priceMode === 'market' ? 'Mkt' : 'Low'}
          </span>
          <span className={`text-sm font-semibold tabular-nums ${unitPrice === null ? 'text-red-400' : 'text-gold'}`}>
            {formatPrice(unitPrice)}
          </span>
        </div>
        {altUnitPrice !== null && (
          <div className="flex items-baseline gap-1 leading-tight text-[10px] text-gray-600">
            <span>{priceMode === 'market' ? 'Low' : 'Mkt'}</span>
            <span className="tabular-nums">{formatPrice(altUnitPrice)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
