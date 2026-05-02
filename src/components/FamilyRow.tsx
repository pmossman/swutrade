import { useState, useCallback } from 'react';
import type { CardVariant, PriceMode } from '../types';
import { adjustPrice, formatPrice, getCardPrice } from '../services/priceService';
import { CardThumb } from './ui/CardThumb';
import { QtyAdjuster } from './ui/QtyAdjuster';
import { extractVariantLabel } from '../variants';

/**
 * Family-mode picker row. Replaces the old per-printing tile in
 * `family` selectionMode pickers (wishlist, looking-for signal). One
 * row per card family, full width. Variants of the family render as
 * full-size card thumbs in two stacks:
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ ░░░ ░░░ ░░░     ░░░ ░░░     Luke Skywalker - Hero of Y…   │
 *   │ ▓▓▓ ▓▓▓ ▓▓▓     ░░░ ░░░     [JTL] · 3 of 5 active   ×N + −│
 *   │ active stack    excluded                                  │
 *   └───────────────────────────────────────────────────────────┘
 *
 * The whole row is the click target. A click adds the family with
 * the current variant restriction (driven by the picker's variant
 * filter), so the visual maps directly to "what would I save?"
 *
 * Active variants render in full colour stacked at fanned offsets so
 * each card behind peeks out behind the primary. Excluded variants
 * (those NOT in the picker's variant filter) render to the right of
 * the active stack with `filter: grayscale(1) brightness(0.45)` —
 * GPU-accelerated, single-pass, no layout reflow on filter toggle.
 */

interface FamilyRowProps {
  /** The family's representative card — drives the row's name +
   *  price + accessibility label. */
  primary: CardVariant;
  /** Every printing in this family, sorted cheapest-first. */
  allVariants: CardVariant[];
  /** Variant labels considered "active" — full-colour. Empty array
   *  means "no filter; treat all as active." */
  activeVariantLabels: readonly string[];
  qty: number;
  priceMode: PriceMode;
  /** 'gold' for list surfaces; 'emerald' / 'blue' reserved for trade
   *  surfaces if this row pattern ever spreads there. */
  accent: 'gold' | 'emerald' | 'blue';
  /** Verb-target for aria-label ("Add … to list"). */
  actionTarget: string;
  onAdd: (card: CardVariant) => void;
  onDecrement: (card: CardVariant) => void;
}

const STACK_OFFSET_PX = 22; // how much of each behind-card peeks out
const THUMB_HEIGHT_PX = 96; // 5:7 card → ~68px wide at this height
const MAX_STACK = 4; // beyond this, render a "+N" indicator

const accentBorderClass: Record<'gold' | 'emerald' | 'blue', string> = {
  gold: 'border-gold/50 shadow-[0_0_0_1px_rgba(245,166,35,0.25)]',
  emerald: 'border-emerald-500/50 shadow-[0_0_0_1px_rgba(52,211,153,0.25)]',
  blue: 'border-blue-500/50 shadow-[0_0_0_1px_rgba(96,165,250,0.25)]',
};

export function FamilyRow({
  primary,
  allVariants,
  activeVariantLabels,
  qty,
  priceMode,
  accent,
  actionTarget,
  onAdd,
  onDecrement,
}: FamilyRowProps) {
  const [pulsing, setPulsing] = useState(false);

  const allActive = activeVariantLabels.length === 0;
  const activeVariants = allActive
    ? allVariants
    : allVariants.filter(v => activeVariantLabels.includes(extractVariantLabel(v.name)));
  const excludedVariants = allActive
    ? []
    : allVariants.filter(v => !activeVariantLabels.includes(extractVariantLabel(v.name)));

  const inDraft = qty > 0;
  const unitPrice = adjustPrice(getCardPrice(primary, priceMode), 100);
  const displayName = primary.displayName ?? primary.name.replace(/\s*\([^)]*\)\s*$/, '').trim();

  const handleAdd = useCallback(() => {
    setPulsing(true);
    onAdd(primary);
    setTimeout(() => setPulsing(false), 200);
  }, [primary, onAdd]);

  const handleKeyActivate = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleAdd();
    }
  }, [handleAdd]);

  const variantSummary = allActive
    ? `${allVariants.length} printing${allVariants.length === 1 ? '' : 's'} · any`
    : `${activeVariants.length} of ${allVariants.length} active`;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleAdd}
      onKeyDown={handleKeyActivate}
      aria-label={`Add ${displayName} to ${actionTarget}`}
      className={`group relative flex items-center gap-3 bg-space-700/40 rounded-lg overflow-hidden border transition-all
        ${inDraft ? accentBorderClass[accent] : 'border-space-600 hover:border-space-500'}
        hover:bg-space-700/70 active:scale-[0.99] cursor-pointer
        focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60
        ${pulsing ? 'animate-tile-add' : ''}
        p-2 sm:p-3
      `}
    >
      <CardStack variants={activeVariants} />
      {excludedVariants.length > 0 && (
        <CardStack variants={excludedVariants} dimmed />
      )}

      <div className="flex-1 min-w-0 self-stretch flex flex-col justify-center">
        <div className="text-sm font-semibold text-gray-100 truncate">{displayName}</div>
        <div className="text-[11px] text-gray-500 truncate">{variantSummary}</div>
        {unitPrice !== null && (
          <div className="flex items-baseline gap-1 mt-0.5 text-[11px]">
            <span className="text-gray-500 uppercase tracking-wide">{priceMode === 'market' ? 'Mkt' : 'Low'}</span>
            <span className="text-gold font-semibold tabular-nums">{formatPrice(unitPrice)}</span>
            <span className="text-gray-600 ml-0.5">(cheapest)</span>
          </div>
        )}
      </div>

      {inDraft && (
        <QtyAdjuster
          variant="pill"
          accent={accent}
          size="lg"
          qty={qty}
          itemName={displayName}
          onDecrement={() => onDecrement(primary)}
        />
      )}
    </div>
  );
}

/**
 * Stacked thumbnails of card variants. Cards beyond `MAX_STACK` get
 * collapsed into a "+N" indicator. Shared between the active and
 * excluded stacks; the `dimmed` prop adds the grayscale + opacity
 * recede via a single CSS filter (GPU-pass, no reflow).
 */
function CardStack({ variants, dimmed = false }: { variants: CardVariant[]; dimmed?: boolean }) {
  if (variants.length === 0) return null;
  const visible = variants.slice(0, MAX_STACK);
  const overflow = variants.length - visible.length;
  // 5:7 card aspect at THUMB_HEIGHT_PX height.
  const thumbWidth = Math.round(THUMB_HEIGHT_PX * (5 / 7));
  const stackWidth = thumbWidth + STACK_OFFSET_PX * (visible.length - 1);
  return (
    <div
      className={`relative shrink-0 transition-[filter,opacity] ${dimmed ? '[filter:grayscale(1)_brightness(0.45)] opacity-60' : ''}`}
      style={{ width: stackWidth, height: THUMB_HEIGHT_PX }}
      aria-hidden
    >
      {visible.map((v, i) => {
        return (
          <div
            key={`${v.productId ?? v.name}`}
            className="absolute top-0 rounded-md overflow-hidden bg-space-900 border border-space-600 shadow-md"
            style={{
              left: i * STACK_OFFSET_PX,
              width: thumbWidth,
              height: THUMB_HEIGHT_PX,
              zIndex: visible.length - i,
            }}
          >
            <CardThumb productId={v.productId} name={v.name ?? ''} size="md" className="w-full h-full" imgSize="sm" />
            {i === visible.length - 1 && overflow > 0 && (
              <span className="absolute bottom-0 right-0 px-1 py-0.5 bg-black/85 text-white text-[10px] font-bold rounded-tl">
                +{overflow}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
