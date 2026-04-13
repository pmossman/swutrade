import { useState, useRef, useCallback } from 'react';
import { toPng } from 'html-to-image';
import type { TradeCard, PriceMode } from '../types';
import { PriceModeToggle } from './PriceModeToggle';
import { tradeCardKey } from '../types';
import { adjustPrice, extractVariantLabel, cardImageUrl, getCardPrice, getAltPrice } from '../services/priceService';

interface TradeSummaryProps {
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
  onPriceModeChange: (mode: PriceMode) => void;
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
                    {variant} &middot;{' '}
                    <span className="text-gray-400">{priceMode === 'market' ? 'Mkt' : 'Low'}</span> {formatPrice(unitPrice)} ea
                    {altUnit !== null && (
                      <span className="text-gray-600 ml-1">
                        <span>{priceMode === 'market' ? 'Low' : 'Mkt'}</span> {formatPrice(altUnit)}
                      </span>
                    )}
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

export function TradeSummary({ yourCards, theirCards, percentage, priceMode, onPriceModeChange, onClose }: TradeSummaryProps) {
  const yourTotal = calcTotal(yourCards, percentage, priceMode);
  const theirTotal = calcTotal(theirCards, percentage, priceMode);
  const diff = yourTotal - theirTotal;
  const absDiff = Math.abs(diff);
  const isEven = absDiff < 0.01;
  const [exporting, setExporting] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);

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

  const handleExport = useCallback(async () => {
    if (!captureRef.current || exporting) return;
    setExporting(true);

    try {
      // html-to-image needs images loaded; run twice for reliability
      const dataUrl = await toPng(captureRef.current, {
        backgroundColor: '#0a0e1a',
        pixelRatio: 2,
      });
      // Re-render for any images that loaded late
      const finalUrl = await toPng(captureRef.current, {
        backgroundColor: '#0a0e1a',
        pixelRatio: 2,
      });

      const blob = await (await fetch(finalUrl)).blob();
      const file = new File([blob], 'swu-trade.png', { type: 'image/png' });

      // Try Web Share API (works on mobile for sharing to Discord etc.)
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'SWU Trade',
        });
      } else {
        // Fallback: download the image
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = 'swu-trade.png';
        a.click();
      }
    } catch (err) {
      // User cancelled share or something went wrong — ignore
      console.warn('Export failed:', err);
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement('input');
      input.value = window.location.href;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-space-900/95 flex flex-col animate-fade-in">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-base font-bold text-gold-bright">Trade Summary</h2>
        <div className="flex items-center gap-2">
          <PriceModeToggle value={priceMode} onChange={onPriceModeChange} />
          <button
            onClick={handleCopyLink}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-space-700 text-gray-300 hover:bg-space-600 transition-colors"
          >
            {linkCopied ? (
              <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            )}
            {linkCopied ? 'Copied!' : 'Link'}
          </button>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-gold/20 text-gold hover:bg-gold/30 transition-colors disabled:opacity-50"
          >
            {exporting ? (
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            )}
            Image
          </button>
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
      </div>

      {/* Capturable content area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div ref={captureRef} className="px-4 pb-4">
          {/* Balance */}
          <div className="pb-3">
            <div className={`text-center text-lg font-bold ${balanceColor}`}>{message}</div>
            <div className="text-center text-[10px] text-gray-500 mt-0.5">
              @ {percentage}% TCGPlayer {priceMode === 'low' ? 'lowest' : 'market'}
            </div>
          </div>

          {/* Card lists */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
            <SideList cards={yourCards} percentage={percentage} priceMode={priceMode} label="You" accentColor="emerald" />
            <SideList cards={theirCards} percentage={percentage} priceMode={priceMode} label="Them" accentColor="blue" />
          </div>

          {/* Watermark for shared image */}
          <div className="mt-3 text-center text-[9px] text-gray-600">
            swutrade.com
          </div>
        </div>
      </div>
    </div>
  );
}
