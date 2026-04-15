import { useState, useCallback } from 'react';
import type { CardVariant, PriceMode } from '../types';
import { adjustPrice, cardImageUrl, getCardPrice, getAltPrice } from '../services/priceService';
import { extractVariantLabel, variantBadgeColor } from '../variants';

interface CardTileProps {
  card: CardVariant;
  qty: number;
  percentage: number;
  priceMode: PriceMode;
  accentColor: 'emerald' | 'blue';
  /** If true, render at landscape (7:5) aspect — set by parent for
   *  leader/base card groups. Overrides image-load detection. */
  landscape?: boolean;
  onAdd: (card: CardVariant) => void;
  onDecrement: (card: CardVariant) => void;
}

function formatPrice(price: number | null): string {
  if (price === null) return 'N/A';
  return `$${price.toFixed(2)}`;
}

const qtyBadgeClass: Record<string, string> = {
  emerald: 'bg-black/85 text-white ring-1 ring-emerald-400/70',
  blue: 'bg-black/85 text-white ring-1 ring-blue-400/70',
};

const accentBorderClass: Record<string, string> = {
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
  accentColor,
  landscape = false,
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

  const handleDecrement = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDecrement(card);
  }, [card, onDecrement]);

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
      aria-label={`Add ${card.name} (${variant}) to trade`}
      // Each base-card group renders in its own grid with column counts
      // tuned to the card orientation, so a landscape tile naturally
      // gets a wider slot and equal visual weight to a portrait tile in
      // its own group — no col-span hacks, no cap-width gutters.
      className={`group relative flex flex-col text-left bg-space-700/40 rounded-lg overflow-hidden border transition-all
        ${inTrade ? accentBorderClass[accentColor] : 'border-space-600 hover:border-space-500'}
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

      {/* Metadata strip — stays tight regardless of tile width */}
      <div className="px-2 py-1.5">
        <div className="flex items-center justify-between gap-1 mb-1 min-h-[20px]">
          <div className="flex items-center gap-1 flex-wrap min-w-0">
            <span className={`text-[9px] leading-none px-1.5 py-0.5 rounded font-medium ${variantBadgeColor(variant)}`}>
              {variant}
            </span>
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
            <button
              type="button"
              onClick={handleDecrement}
              className={`shrink-0 inline-flex items-center gap-1 pl-2 pr-1.5 h-6 rounded-full text-[11px] font-bold tabular-nums transition-colors ${qtyBadgeClass[accentColor]} hover:brightness-110 active:scale-95`}
              aria-label={qty <= 1 ? `Remove ${card.name}` : `Decrease quantity of ${card.name}`}
              title={qty <= 1 ? 'Remove (one in trade)' : `Decrease (${qty} in trade)`}
            >
              <span>×{qty}</span>
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-black/25 text-xs leading-none">
                {qty <= 1 ? '×' : '−'}
              </span>
            </button>
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
