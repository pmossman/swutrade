/**
 * Side-colored quantity stepper used on trade rows and card tiles.
 *
 * Three inline reimplementations existed before in TradeRow (split
 * +/− buttons), CardTile (rounded-full pill `×N −`), and FamilyRow
 * (same pill, slightly larger). They shared an emerald/blue/gold
 * side-color map via byte-identical local `qtyBadgeClass` objects
 * and slightly diverged in everything else: aria-label conventions,
 * `qty <= 1 → remove` rendering, hit-area, and event-handler shapes.
 *
 * Audit 10-ux-primitives.md #1.
 *
 * Two variants:
 *   - `split`: two independent buttons (`-` and `+`) flanking a qty
 *     value. TradeRow style. Pass `onIncrement` and `onDecrement`.
 *   - `pill`: single button rendering `×N −` as a clickable
 *     decrement; the parent tile owns the increment via its own
 *     click handler. CardTile / FamilyRow style.
 *
 * Accent preserves the SWU side-color invariant: emerald = your side,
 * blue = their side, gold = neutral. Don't collapse to a single accent.
 *
 * `qty <= 1` is the "remove" semantic everywhere — the decrement
 * button visually turns into × and uses the `onRemove` handler if
 * provided, falling back to `onDecrement(-1)` otherwise.
 */

import type { ReactNode } from 'react';

export type QtyAdjusterAccent = 'gold' | 'emerald' | 'blue';

export type QtyAdjusterSize = 'sm' | 'md' | 'lg';

interface CommonProps {
  qty: number;
  accent: QtyAdjusterAccent;
  /** Item name baked into pill aria-label as
   *  "Decrease quantity of ${itemName}" / "Remove ${itemName}".
   *  Split variant ignores it (the row has an accessible header). */
  itemName?: string;
  /** Optional className appended to the outer container. */
  className?: string;
}

interface SplitProps extends CommonProps {
  variant: 'split';
  size: QtyAdjusterSize;
  onIncrement: () => void;
  onDecrement: () => void;
  /** Optional explicit "remove" handler when qty <= 1. Falls back to
   *  the decrement handler when omitted. */
  onRemove?: () => void;
}

interface PillProps extends CommonProps {
  variant: 'pill';
  /** Pill sizes: `md` matches CardTile (h-6, text-[11px]); `lg`
   *  matches FamilyRow (h-7, text-[12px]). */
  size?: 'md' | 'lg';
  /** Decrement / remove handler. Pill has no increment — that's
   *  delegated to the parent tile's click handler. */
  onDecrement: () => void;
  onRemove?: () => void;
}

const QTY_BTN_SIDE: Record<QtyAdjusterAccent, string> = {
  gold: 'text-gold bg-gold/10 hover:bg-gold/20 active:bg-gold/30',
  emerald: 'text-emerald-400 bg-emerald-900/30 hover:bg-emerald-900/50 active:bg-emerald-900/70',
  blue: 'text-blue-400 bg-blue-900/30 hover:bg-blue-900/50 active:bg-blue-900/70',
};

const QTY_BADGE: Record<QtyAdjusterAccent, string> = {
  gold: 'bg-black/85 text-white ring-1 ring-gold/70',
  emerald: 'bg-black/85 text-white ring-1 ring-emerald-400/70',
  blue: 'bg-black/85 text-white ring-1 ring-blue-400/70',
};

const SPLIT_BTN_SIZE: Record<QtyAdjusterSize, string> = {
  sm: 'w-5 h-5 text-[10px]',
  md: 'w-6 h-6 text-xs',
  lg: 'w-8 h-8 text-sm',
};

const SPLIT_QTY_SIZE: Record<QtyAdjusterSize, string> = {
  sm: 'w-4 text-[10px]',
  md: 'w-5 text-xs',
  lg: 'w-6 text-sm',
};

const PILL_SIZE: Record<'md' | 'lg', string> = {
  md: 'h-6 text-[11px]',
  lg: 'h-7 text-[12px]',
};

export function QtyAdjuster(props: SplitProps | PillProps): ReactNode {
  if (props.variant === 'split') {
    const { qty, accent, size, onIncrement, onDecrement, onRemove, className = '' } = props;
    const handleDecrement = qty <= 1
      ? (onRemove ?? onDecrement)
      : onDecrement;
    const decrementClasses = `hit-area-44 ${SPLIT_BTN_SIZE[size]} rounded flex items-center justify-center font-bold transition-colors active:scale-90 ${qty <= 1 ? 'text-red-400 bg-red-900/30 hover:bg-red-900/50' : QTY_BTN_SIDE[accent]}`;
    const incrementClasses = `hit-area-44 ${SPLIT_BTN_SIZE[size]} rounded flex items-center justify-center font-bold transition-colors active:scale-90 ${QTY_BTN_SIDE[accent]}`;
    const qtyValueClasses = `${SPLIT_QTY_SIZE[size]} text-center font-bold text-gray-200 tabular-nums`;
    return (
      <div className={`flex items-center gap-0.5 shrink-0 ${className}`}>
        <button
          type="button"
          onClick={handleDecrement}
          className={decrementClasses}
          aria-label={qty <= 1 ? 'Remove' : 'Decrease quantity'}
        >
          {qty <= 1 ? '×' : '−'}
        </button>
        <span className={qtyValueClasses}>{qty}</span>
        <button
          type="button"
          onClick={onIncrement}
          className={incrementClasses}
          aria-label="Increase quantity"
        >
          +
        </button>
      </div>
    );
  }

  // pill
  const { qty, accent, itemName, size = 'md', onDecrement, onRemove, className = '' } = props;
  const handler = qty <= 1 ? (onRemove ?? onDecrement) : onDecrement;
  // Pills always nest inside a clickable tile/row, so stop the click
  // from bubbling to the parent's add handler.
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handler();
  };
  const ariaLabel = itemName
    ? (qty <= 1 ? `Remove ${itemName}` : `Decrease quantity of ${itemName}`)
    : (qty <= 1 ? 'Remove' : 'Decrease quantity');
  const title = qty <= 1 ? 'Remove' : `Decrease (${qty} in trade)`;
  return (
    <button
      type="button"
      onClick={handleClick}
      className={`shrink-0 inline-flex items-center gap-1 pl-2 pr-1.5 ${PILL_SIZE[size]} rounded-full font-bold tabular-nums transition-colors ${QTY_BADGE[accent]} hover:brightness-110 active:scale-95 ${className}`}
      aria-label={ariaLabel}
      title={title}
    >
      <span>×{qty}</span>
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-black/25 text-xs leading-none">
        {qty <= 1 ? '×' : '−'}
      </span>
    </button>
  );
}
