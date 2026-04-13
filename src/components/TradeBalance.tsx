import type { TradeCard, PriceMode } from '../types';
import { adjustPrice, getCardPrice } from '../services/priceService';

interface TradeBalanceProps {
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
}

function calcTotal(cards: TradeCard[], percentage: number, priceMode: PriceMode): number {
  return cards.reduce((sum, tc) => {
    const adj = adjustPrice(getCardPrice(tc.card, priceMode), percentage);
    return sum + (adj ?? 0) * tc.qty;
  }, 0);
}

export function TradeBalance({ yourCards, theirCards, percentage, priceMode }: TradeBalanceProps) {
  const yourTotal = calcTotal(yourCards, percentage, priceMode);
  const theirTotal = calcTotal(theirCards, percentage, priceMode);
  const diff = yourTotal - theirTotal;
  const absDiff = Math.abs(diff);
  const isEven = absDiff < 0.01;
  const isEmpty = yourCards.length === 0 && theirCards.length === 0;

  let message: string;
  let colorClass: string;
  let bgClass: string;

  if (isEmpty) {
    message = 'Add cards to balance a trade';
    colorClass = 'text-gray-500';
    bgClass = 'border-space-600 bg-space-800';
  } else if (isEven) {
    message = 'Trade is even!';
    colorClass = 'text-emerald-400';
    bgClass = 'border-emerald-500/30 bg-emerald-950/30';
  } else if (diff > 0) {
    message = `They owe you $${absDiff.toFixed(2)}`;
    colorClass = 'text-emerald-400';
    bgClass = 'border-emerald-500/30 bg-emerald-950/30';
  } else {
    message = `You owe them $${absDiff.toFixed(2)}`;
    colorClass = 'text-amber-400';
    bgClass = 'border-amber-500/30 bg-amber-950/30';
  }

  return (
    <div className={`rounded-xl border-2 px-4 py-3 transition-all ${bgClass}`}>
      <div className={`text-xl font-bold text-center ${colorClass}`}>
        {message}
      </div>
      {!isEmpty && (
        <>
          <div className="text-[11px] text-gray-500 mt-0.5 text-center">
            You: ${yourTotal.toFixed(2)} &middot; Them: ${theirTotal.toFixed(2)} &middot; @ {percentage}% {priceMode === 'low' ? 'Low' : 'Market'}
          </div>
          <div className="mt-2 flex items-center justify-center gap-1.5 text-xs font-semibold text-gold/80">
            <span>View Summary</span>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
