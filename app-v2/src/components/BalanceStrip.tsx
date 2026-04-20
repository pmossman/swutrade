import type { ReactNode } from 'react';
import { missingPriceCount } from '../lib/trade';
import type { TradeCardSnapshot } from '../lib/trade';

interface BalanceStripProps {
  yourTotal: number;
  theirTotal: number;
  yourCards: ReadonlyArray<TradeCardSnapshot>;
  theirCards: ReadonlyArray<TradeCardSnapshot>;
  onOpenPricing?: () => void;
  trailing?: ReactNode;
}

/*
 * Design §4.3 balance strip. Collapsed by default; tap to open the
 * PriceSheet (§4.3.1). PriceSheet wiring lands in a follow-up; for
 * now the onOpenPricing callback is optional and the tap simply
 * opens the sheet if provided.
 *
 * Scannable signal at a glance:
 *   $34.50 ⇆ $36.00 · ▲$1.50
 *   with a "N missing price" caption when any card lacks pricing
 */
export function BalanceStrip({
  yourTotal,
  theirTotal,
  yourCards,
  theirCards,
  onOpenPricing,
  trailing,
}: BalanceStripProps) {
  const diff = Math.round((theirTotal - yourTotal) * 100) / 100;
  const absDiff = Math.abs(diff);
  const favored: 'balanced' | 'yours' | 'theirs' =
    absDiff < 0.01 ? 'balanced' : diff > 0 ? 'yours' : 'theirs';
  const missing = missingPriceCount(yourCards) + missingPriceCount(theirCards);

  return (
    <div className="rounded-2xl border border-border bg-surface">
      <button
        type="button"
        onClick={onOpenPricing}
        disabled={!onOpenPricing}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-border/20 disabled:hover:bg-transparent"
        aria-label="Open pricing"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[length:var(--text-body)] font-semibold tabular-nums">
            <span>${yourTotal.toFixed(2)}</span>
            <span aria-hidden="true" className="text-fg-muted">
              ⇆
            </span>
            <span>${theirTotal.toFixed(2)}</span>
            {favored !== 'balanced' ? (
              <span className="text-[length:var(--text-meta)] font-medium text-state-attention">
                {favored === 'yours' ? '▲' : '▼'}${absDiff.toFixed(2)}
              </span>
            ) : (
              <span className="text-[length:var(--text-meta)] font-medium text-state-settled">
                balanced
              </span>
            )}
          </div>
          {missing > 0 ? (
            <p className="mt-0.5 text-[length:var(--text-caption)] text-danger">
              {missing} {missing === 1 ? 'card' : 'cards'} missing price
            </p>
          ) : null}
        </div>
        {trailing}
      </button>
    </div>
  );
}
