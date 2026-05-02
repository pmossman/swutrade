import type { CardVariant, PriceMode } from '../types';
import {
  adjustPrice,
  cardTcgPlayerUrl,
  formatPrice,
  getCardPrice,
  getAltPrice,
} from '../services/priceService';
import { extractBaseName, extractVariantLabel } from '../variants';
import { VariantBadge } from './VariantBadge';
import { KebabMenu, type KebabMenuItem } from './KebabMenu';
import { CardThumb, type ThumbSize } from './ui/CardThumb';
import { QtyAdjuster } from './ui/QtyAdjuster';

export type { ThumbSize };
export type AccentColor = 'emerald' | 'blue';

// Missing prices silently get treated as $0 in the totals, which can throw
// off a trade by a lot — make them loud at every level (row tint, border,
// icon) so the user can't miss them.
const priceClass = (price: number | null, defaultClass: string) =>
  price === null ? 'text-red-400 font-bold' : defaultClass;

const MissingPriceIcon = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
  </svg>
);

const ROW_PADS: Record<ThumbSize, string> = {
  lg: 'px-3 py-3 gap-3',
  md: 'px-2.5 py-1.5 gap-2',
  sm: 'px-2 py-1 gap-1.5',
  xs: 'px-1.5 py-0.5 gap-1.5',
};

interface TradeRowProps {
  card: CardVariant;
  qty: number;
  percentage: number;
  priceMode: PriceMode;
  size: ThumbSize;
  accentColor: AccentColor;
  /** Apply a delta to qty. Caller decides what `−1` does at qty 1
   *  (typically: route to onRemove); the row itself wires the
   *  decrement button to onRemove when qty <= 1. */
  onChangeQty: (delta: number) => void;
  onRemove: () => void;
  /** Open the search overlay seeded with this card's basename so the
   *  user can swap to a different variant (the picker doesn't support
   *  in-place edits yet). */
  onReplace: () => void;
  /** Read-only mode — drops the qty stepper + kebab, renders qty as a
   *  static "× N" badge instead. Used for the counterpart side of a
   *  shared trade session and for the viewer's side once the session
   *  is settled / cancelled / expired. */
  readOnly?: boolean;
  /** Extra kebab-menu items appended to the row's defaults. When the
   *  row is otherwise read-only, providing extras keeps the kebab
   *  rendered so callers can attach context-specific actions
   *  (e.g. session counterpart panel: "Suggest remove this card"). */
  extraMenuItems?: KebabMenuItem[];
}

/**
 * One line in a trade-side panel. Owns its own price formatting,
 * thumbnail aspect detection, and qty stepper chrome — the parent
 * picks the size + accent and threads handlers scoped to this card.
 */
export function TradeRow({
  card,
  qty,
  percentage,
  priceMode,
  size,
  accentColor,
  onChangeQty,
  onRemove,
  onReplace,
  readOnly = false,
  extraMenuItems,
}: TradeRowProps) {
  const unitPrice = adjustPrice(getCardPrice(card, priceMode), percentage);
  const altUnitPrice = adjustPrice(getAltPrice(card, priceMode), percentage);
  const lineTotal = unitPrice !== null ? unitPrice * qty : null;
  const variant = extractVariantLabel(card.name);

  // Market↔Low spread. Computed off raw (unadjusted) prices so the
  // percentage tracks the cards themselves, not the user's negotiation
  // slider. Require BOTH a meaningful ratio and a dollar-gap floor —
  // a $0.30 → $0.20 card is 33% but nobody cares about 10 cents.
  const marketRaw = getCardPrice(card, 'market');
  const lowRaw = getCardPrice(card, 'low');
  const spreadDollar = (marketRaw !== null && lowRaw !== null) ? marketRaw - lowRaw : null;
  const spreadPct = (marketRaw !== null && lowRaw !== null && marketRaw > 0)
    ? (marketRaw - lowRaw) / marketRaw
    : null;
  const spreadHigh = spreadPct !== null && spreadPct >= 0.25 && (spreadDollar ?? 0) >= 0.5;

  const isCompact = size === 'sm' || size === 'xs';
  const isLarge = size === 'lg';
  const tcgUrl = cardTcgPlayerUrl(card.productId);
  const missingPrice = unitPrice === null;

  // Loud red border + tinted background when a row has no price —
  // these line items contribute $0 to the total and are easy to gloss
  // over otherwise.
  const rowClasses = missingPrice
    ? `group flex items-center ${ROW_PADS[size]} border-l-4 border-red-500 bg-red-950/30`
    : `group flex items-center ${ROW_PADS[size]} hover:bg-space-700/30 transition-colors`;

  const spreadBadge = spreadHigh && spreadPct !== null ? (
    <span
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 text-[9px] font-semibold leading-none"
      title={`Wide spread: Market $${(marketRaw ?? 0).toFixed(2)} vs Low $${(lowRaw ?? 0).toFixed(2)}`}
    >
      Δ{Math.round(spreadPct * 100)}%
    </span>
  ) : null;

  const menuItems: KebabMenuItem[] = [];
  if (tcgUrl) {
    menuItems.push({
      label: 'View on TCGPlayer',
      href: tcgUrl,
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      ),
    });
  }
  // Swap variant is editor-side only — it routes through onReplace
  // which opens the picker on the row's own panel. Read-only rows
  // (counterpart side) skip it.
  if (!readOnly) {
    menuItems.push({
      label: 'Swap variant',
      onClick: onReplace,
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 3l4 4m0 0l-4 4m4-4H4m4 14l-4-4m0 0l4-4m-4 4h16" />
        </svg>
      ),
    });
  }
  if (extraMenuItems && extraMenuItems.length > 0) {
    menuItems.push(...extraMenuItems);
  }

  const stepperSize: 'sm' | 'md' | 'lg' = isCompact ? 'sm' : isLarge ? 'lg' : 'md';
  const lineTotalClasses = `${isCompact ? 'text-[10px] w-11' : isLarge ? 'text-sm w-16' : 'text-xs w-14'} font-semibold tabular-nums shrink-0 text-right ${priceClass(lineTotal, 'text-gold')}`;

  return (
    <div className={rowClasses}>
      <div className="shrink-0">
        <CardThumb productId={card.productId} name={card.name} size={size} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {missingPrice && (
            <span className="text-red-400 shrink-0" title="No price data">
              <MissingPriceIcon className={isCompact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
            </span>
          )}
          <span className={`text-gray-100 leading-tight ${isLarge ? 'text-sm font-semibold' : isCompact ? 'text-[11px] truncate' : 'text-xs truncate'}`}>
            {extractBaseName(card.name)}
          </span>
          <VariantBadge variant={variant} shrink />
          {isLarge && spreadBadge}
        </div>
        {!isCompact && !isLarge && (
          <div className="flex items-center gap-1.5 flex-wrap leading-tight mt-0.5 text-[10px] text-gray-500">
            {spreadBadge}
            <span>
              <span className="text-gray-400">{priceMode === 'market' ? 'Mkt' : 'Low'}</span>{' '}
              <span className={priceClass(unitPrice, '')}>{formatPrice(unitPrice)}</span> ea
              {altUnitPrice !== null && (
                <span className="text-gray-600 ml-1">
                  <span className="text-gray-600">{priceMode === 'market' ? 'Low' : 'Mkt'}</span> {formatPrice(altUnitPrice)}
                </span>
              )}
            </span>
          </div>
        )}
        {isLarge && (
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span className="flex items-baseline gap-1">
              <span className="text-[9px] uppercase tracking-wide text-gray-500">{priceMode === 'market' ? 'Mkt' : 'Low'}</span>
              <span className={`tabular-nums ${priceClass(unitPrice, 'text-gray-400')}`}>
                {formatPrice(unitPrice)}
              </span>
            </span>
            {altUnitPrice !== null && (
              <span className="flex items-baseline gap-1 text-gray-600">
                <span className="text-[9px] uppercase tracking-wide">{priceMode === 'market' ? 'Low' : 'Mkt'}</span>
                <span className="tabular-nums">{formatPrice(altUnitPrice)}</span>
              </span>
            )}
          </div>
        )}
      </div>
      {/* Kebab renders when there's something in the menu — for
          read-only rows that would normally hide the kebab, callers
          can still surface actions via `extraMenuItems` (e.g. session
          counterpart panel: "Suggest remove this card"). */}
      {menuItems.length > 0 && (
        <div className="shrink-0 hover-reveal">
          <KebabMenu items={menuItems} size={isCompact ? 'xs' : isLarge ? 'md' : 'sm'} />
        </div>
      )}
      {!readOnly && (
        <QtyAdjuster
          variant="split"
          accent={accentColor}
          size={stepperSize}
          qty={qty}
          onIncrement={() => onChangeQty(1)}
          onDecrement={() => onChangeQty(-1)}
          onRemove={onRemove}
        />
      )}
      {readOnly && qty > 1 && (
        <span className={`shrink-0 ${isCompact ? 'text-[10px]' : isLarge ? 'text-sm' : 'text-xs'} tabular-nums text-gray-400 font-semibold`}>
          × {qty}
        </span>
      )}
      <span className={lineTotalClasses}>{formatPrice(lineTotal)}</span>
    </div>
  );
}
