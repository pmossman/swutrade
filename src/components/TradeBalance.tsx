import type { TradeCard, PriceMode } from '../types';
import { adjustPrice, getCardPrice, countMissingPrices } from '../services/priceService';
import { computeBalance, balanceChrome } from '../utils/forceBalance';

interface TradeBalanceProps {
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Primary action when the banner is tapped while expanded — opens
   *  the summary modal. When collapsed, a tap expands first; the
   *  primary action only fires once content is already visible. */
  onPrimary?: () => void;
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

export function TradeBalance({
  yourCards,
  theirCards,
  percentage,
  priceMode,
  collapsed = false,
  onToggleCollapse,
  onPrimary,
}: TradeBalanceProps) {
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
      actionLine = (
        <>
          Ask for <span className={`font-bold tabular-nums ${chrome.headline}`}>{amount}</span> more to restore balance
        </>
      );
    } else {
      actionLine = (
        <>
          Offer <span className={`font-bold tabular-nums ${chrome.headline}`}>{amount}</span> more to restore balance
        </>
      );
    }
  }

  // Chevron — colored to match the balance tone (gold / amber / crimson)
  // so it reads as part of the box, not a generic system control.
  const chevron = onToggleCollapse ? (
    <span className={`shrink-0 flex items-center justify-center w-5 h-5 ${chrome.headline}`} aria-hidden>
      <svg
        className={`w-4 h-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
      </svg>
    </span>
  ) : null;

  // Tap behavior: collapsed → expand first; expanded → fire primary
  // (open summary). Both can be undefined (no-op fallback).
  const handleClick = onToggleCollapse || onPrimary
    ? () => {
        if (collapsed && onToggleCollapse) onToggleCollapse();
        else if (onPrimary) onPrimary();
        else if (onToggleCollapse) onToggleCollapse();
      }
    : undefined;

  // Wrap as a button when the banner is interactive; static div otherwise.
  // Whole-banner click target is more forgiving on mobile than a tiny
  // chevron button.
  if (collapsed) {
    const collapsedContent = (
      <div className={`flex items-center gap-2 px-2 py-1.5 ${chrome.bg}`}>
        {chevron}
        <span className={`swu-display text-[11px] ${chrome.headline} truncate`}>
          {balance.headline}
        </span>
        {actionLine && (
          <span className="text-[11px] text-gray-300 truncate">· {actionLine}</span>
        )}
        {!isEmpty && !actionLine && (
          <span className="text-[11px] text-gray-500 tabular-nums">
            · {formatDollars(yourTotal)} / {formatDollars(theirTotal)}
          </span>
        )}
      </div>
    );
    return handleClick ? (
      <button
        type="button"
        onClick={handleClick}
        aria-label="Expand balance"
        aria-expanded={false}
        className={`w-full text-left rounded-xl border ${chrome.border} ${glowClass} hover:bg-white/[0.02] active:bg-white/[0.04] transition-colors`}
      >
        {collapsedContent}
      </button>
    ) : (
      <div className={`rounded-xl border ${chrome.border} ${glowClass}`}>{collapsedContent}</div>
    );
  }

  const expandedContent = (
    <>
      {chevron && (
        <div className="absolute top-2 left-2">
          {chevron}
        </div>
      )}
      <div className={`swu-display text-[11px] sm:text-base text-center ${chrome.headline}`}>
        {balance.headline}
      </div>
      {actionLine && (
        <div className="text-[12px] sm:text-sm mt-1 sm:mt-1.5 text-center text-gray-300">
          {actionLine}
        </div>
      )}
      {!isEmpty && (
        <div className="mt-1.5 sm:mt-2 flex items-center justify-center gap-2 sm:gap-3 flex-wrap text-[10px] sm:text-[11px] tabular-nums">
          <span className="flex items-baseline gap-1">
            <span className="text-emerald-400/70 uppercase text-[8px] sm:text-[9px] tracking-widest font-semibold">Offer</span>
            <span className="text-emerald-200 font-semibold">{formatDollars(yourTotal)}</span>
          </span>
          <span className="text-space-600" aria-hidden>·</span>
          <span className="flex items-baseline gap-1">
            <span className="text-blue-400/70 uppercase text-[8px] sm:text-[9px] tracking-widest font-semibold">Receive</span>
            <span className="text-blue-200 font-semibold">{formatDollars(theirTotal)}</span>
          </span>
          <span className="text-space-600" aria-hidden>·</span>
          <span className="text-gray-500">
            @ {percentage}% {priceMode === 'low' ? 'Low' : 'Market'}
          </span>
        </div>
      )}
      {missingTotal > 0 && (
        <div className="mt-1.5 sm:mt-2 mx-auto max-w-md flex items-center justify-center gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-md bg-red-950/60 border border-red-500/60 text-[11px] sm:text-xs font-bold text-red-300">
          <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span>
            {missingTotal} card{missingTotal === 1 ? '' : 's'} missing price
          </span>
        </div>
      )}
      {!isEmpty && onPrimary && (
        <div className="mt-1.5 sm:mt-2 flex items-center justify-center gap-1.5 text-[10px] sm:text-[11px] font-semibold text-gold/70">
          <span>View full summary</span>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </div>
      )}
    </>
  );

  const expandedWrapper = `relative rounded-xl border px-3 py-2 sm:px-4 sm:py-3 transition-all ${chrome.border} ${chrome.bg} ${glowClass}`;
  return handleClick ? (
    <button
      type="button"
      onClick={handleClick}
      aria-label={onPrimary ? 'Open trade summary' : 'Collapse balance'}
      aria-expanded={true}
      className={`${expandedWrapper} w-full text-left hover:bg-white/[0.02] active:scale-[0.98]`}
    >
      {expandedContent}
    </button>
  ) : (
    <div className={expandedWrapper}>{expandedContent}</div>
  );
}
