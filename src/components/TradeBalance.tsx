import type { TradeCard, PriceMode } from '../types';
import { adjustPrice, getCardPrice, countMissingPrices } from '../services/priceService';
import { computeBalance, balanceChrome } from '../utils/forceBalance';

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

function formatDollars(n: number) {
  return `$${n.toFixed(2)}`;
}

export function TradeBalance({ yourCards, theirCards, percentage, priceMode }: TradeBalanceProps) {
  const yourTotal = calcTotal(yourCards, percentage, priceMode);
  const theirTotal = calcTotal(theirCards, percentage, priceMode);
  const isEmpty = yourCards.length === 0 && theirCards.length === 0;
  const balance = computeBalance(yourTotal, theirTotal, isEmpty);
  const chrome = balanceChrome(balance.tone);

  const missingYou = countMissingPrices(yourCards, priceMode);
  const missingThem = countMissingPrices(theirCards, priceMode);
  const missingTotal = missingYou + missingThem;

  const glowClass = balance.tier === 'chaos' ? 'animate-pulse-crimson' : chrome.glow;

  // Thematic action line. The "offer" / "seek" verbs depend on who's
  // currently underpaying: if the trade favors THEM, you need to ask
  // for more; if it favors YOU, they need to give more (you'd offer a
  // card OR ask them for cash).
  let actionLine: React.ReactNode = null;
  if (balance.tier !== 'balanced' && balance.absDiff >= 0.01) {
    const amount = formatDollars(balance.absDiff);
    if (balance.favored === 'them') {
      // You're giving more — you need more from them.
      actionLine = (
        <>
          Ask for <span className={`font-bold tabular-nums ${chrome.headline}`}>{amount}</span> more to restore balance
        </>
      );
    } else {
      // You're getting more — you'd offer more to them.
      actionLine = (
        <>
          Offer <span className={`font-bold tabular-nums ${chrome.headline}`}>{amount}</span> more to restore balance
        </>
      );
    }
  }

  return (
    <div className={`rounded-xl border px-4 py-3 transition-all ${chrome.border} ${chrome.bg} ${glowClass}`}>
      {/* Headline — flavor */}
      <div className={`swu-display text-sm sm:text-base text-center ${chrome.headline}`}>
        {balance.headline}
      </div>

      {/* Action line — the practical call to action in thematic language */}
      {actionLine && (
        <div className="text-[13px] sm:text-sm mt-1.5 text-center text-gray-300">
          {actionLine}
        </div>
      )}

      {/* Side totals with color-coded labels — emerald for Offering,
          blue for Receiving. Gold for the gap. Gray for pricing meta. */}
      {!isEmpty && (
        <div className="mt-2 flex items-center justify-center gap-3 flex-wrap text-[11px] tabular-nums">
          <span className="flex items-baseline gap-1">
            <span className="text-emerald-400/70 uppercase text-[9px] tracking-widest font-semibold">Offer</span>
            <span className="text-emerald-200 font-semibold">{formatDollars(yourTotal)}</span>
          </span>
          <span className="text-space-600" aria-hidden>·</span>
          <span className="flex items-baseline gap-1">
            <span className="text-blue-400/70 uppercase text-[9px] tracking-widest font-semibold">Receive</span>
            <span className="text-blue-200 font-semibold">{formatDollars(theirTotal)}</span>
          </span>
          <span className="text-space-600" aria-hidden>·</span>
          <span className="text-gray-500">
            @ {percentage}% {priceMode === 'low' ? 'Low' : 'Market'}
          </span>
        </div>
      )}

      {missingTotal > 0 && (
        <div className="mt-2 mx-auto max-w-md flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-red-950/60 border border-red-500/60 text-xs font-bold text-red-300">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span>
            {missingTotal} card{missingTotal === 1 ? '' : 's'} missing price — balance is incomplete
          </span>
        </div>
      )}

      {!isEmpty && (
        <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-gold/70 hover:text-gold transition-colors">
          <span>View full summary</span>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </div>
      )}
    </div>
  );
}
