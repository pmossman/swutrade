import { useState } from 'react';
import type { TradeCard, PriceMode } from '../types';
import { tradeCardKey } from '../types';
import { adjustPrice, extractVariantLabel, cardImageUrl, getCardPrice, getAltPrice } from '../services/priceService';

interface TradeSummaryProps {
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
  onClose: () => void;
}

function formatPrice(price: number | null): string {
  if (price === null) return 'N/A';
  return `$${price.toFixed(2)}`;
}

function calcTotal(cards: TradeCard[], percentage: number, priceMode: PriceMode): number {
  return cards.reduce((sum, tc) => {
    const adj = adjustPrice(getCardPrice(tc.card, priceMode), percentage);
    return sum + (adj ?? 0) * tc.qty;
  }, 0);
}

function MiniThumb({ productId, name }: { productId?: string; name: string }) {
  const [errored, setErrored] = useState(false);
  const src = cardImageUrl(productId, 'md');

  if (!src || errored) {
    return <div className="w-6 h-8 rounded-sm bg-space-600 shrink-0" />;
  }

  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      onError={() => setErrored(true)}
      className="w-6 h-8 rounded-sm object-cover shrink-0 bg-space-600"
    />
  );
}

function SideList({ cards, percentage, priceMode, label, accentColor }: {
  cards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
  label: string;
  accentColor: string;
}) {
  const total = calcTotal(cards, percentage, priceMode);
  const labelColor = accentColor === 'emerald' ? 'text-emerald-400' : 'text-blue-400';
  const borderColor = accentColor === 'emerald' ? 'border-emerald-500/30' : 'border-blue-500/30';

  return (
    <div>
      <div className={`flex items-center justify-between pb-1.5 mb-2 border-b ${borderColor}`}>
        <span className={`text-xs font-semibold uppercase tracking-wide ${labelColor}`}>{label}</span>
        <span className={`text-sm font-bold tabular-nums ${labelColor}`}>{formatPrice(total)}</span>
      </div>
      {cards.length === 0 ? (
        <div className="text-gray-600 text-xs py-2">No cards</div>
      ) : (
        <div className="space-y-1">
          {cards.map(tc => {
            const key = tradeCardKey(tc.card);
            const unitPrice = adjustPrice(getCardPrice(tc.card, priceMode), percentage);
            const lineTotal = unitPrice !== null ? unitPrice * tc.qty : null;
            const altUnit = adjustPrice(getAltPrice(tc.card, priceMode), percentage);
            const variant = extractVariantLabel(tc.card.name);
            return (
              <div key={key} className="flex items-center gap-1.5">
                <MiniThumb productId={tc.card.productId} name={tc.card.name} />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-gray-200 truncate leading-tight">{tc.card.name}</div>
                  <div className="text-[9px] text-gray-500 leading-tight">
                    {variant}
                    {altUnit !== null && <span className="text-gray-600 ml-1">({formatPrice(altUnit)} ea)</span>}
                  </div>
                </div>
                {tc.qty > 1 && (
                  <span className="text-[10px] text-gray-400 tabular-nums shrink-0">x{tc.qty}</span>
                )}
                <span className="text-[11px] font-semibold text-gold tabular-nums shrink-0 w-12 text-right">
                  {formatPrice(lineTotal)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TradeSummary({ yourCards, theirCards, percentage, priceMode, onClose }: TradeSummaryProps) {
  const yourTotal = calcTotal(yourCards, percentage, priceMode);
  const theirTotal = calcTotal(theirCards, percentage, priceMode);
  const diff = yourTotal - theirTotal;
  const absDiff = Math.abs(diff);
  const isEven = absDiff < 0.01;

  let message: string;
  let balanceColor: string;

  if (isEven) {
    message = 'Trade is even!';
    balanceColor = 'text-emerald-400';
  } else if (diff > 0) {
    message = `They owe you ${formatPrice(absDiff)}`;
    balanceColor = 'text-emerald-400';
  } else {
    message = `You owe them ${formatPrice(absDiff)}`;
    balanceColor = 'text-amber-400';
  }

  return (
    <div className="fixed inset-0 z-50 bg-space-900/95 flex flex-col animate-fade-in">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-base font-bold text-gold-bright">Trade Summary</h2>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 transition-colors p-1"
          aria-label="Close summary"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Balance */}
      <div className="shrink-0 px-4 pb-3">
        <div className={`text-center text-lg font-bold ${balanceColor}`}>{message}</div>
        <div className="text-center text-[10px] text-gray-500 mt-0.5">
          @ {percentage}% TCGPlayer {priceMode === 'low' ? 'lowest' : 'market'}
        </div>
      </div>

      {/* Card lists */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
          <SideList cards={yourCards} percentage={percentage} priceMode={priceMode} label="You" accentColor="emerald" />
          <SideList cards={theirCards} percentage={percentage} priceMode={priceMode} label="Them" accentColor="blue" />
        </div>
      </div>
    </div>
  );
}
