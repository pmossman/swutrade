import { useState, useEffect, useCallback } from 'react';
import type { TradeCard, PriceMode } from '../types';
import { PriceModeToggle } from './PriceModeToggle';
import { PriceSlider } from './PriceSlider';
import { ShareButtons } from './ShareButtons';
import { MobileActionsKebab } from './MobileActionsKebab';
import { tradeCardKey } from '../types';
import { adjustPrice, formatPrice, getCardPrice, countMissingPrices } from '../services/priceService';
import { CardThumb } from './ui/CardThumb';
import { extractVariantLabel, extractBaseName } from '../variants';
import { VariantBadge } from './VariantBadge';
import { computeBalance, balanceChrome } from '../utils/forceBalance';
import { useAuthContext } from '../contexts/AuthContext';
import { usePricing } from '../contexts/PricingContext';
import { HandlePickerDialog } from './HandlePickerDialog';
import { buildTradeSearch } from '../urlCodec';

interface TradeSummaryProps {
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  onClose: () => void;
}

function calcTotal(cards: TradeCard[], percentage: number, priceMode: PriceMode): number {
  return cards.reduce((sum, tc) => {
    const adj = adjustPrice(getCardPrice(tc.card, priceMode), percentage);
    return sum + (adj ?? 0) * tc.qty;
  }, 0);
}

function SummaryTile({ tc, percentage, priceMode, accentColor }: {
  tc: TradeCard;
  percentage: number;
  priceMode: PriceMode;
  accentColor: 'emerald' | 'blue';
}) {
  const unitPrice = adjustPrice(getCardPrice(tc.card, priceMode), percentage);
  const lineTotal = unitPrice !== null ? unitPrice * tc.qty : null;
  const missingPrice = unitPrice === null;
  const qtyBg = accentColor === 'emerald'
    ? 'bg-black/85 text-white ring-1 ring-emerald-400/70'
    : 'bg-black/85 text-white ring-1 ring-blue-400/70';

  // All tiles use portrait 5:7 aspect for grid uniformity. Leader/base
  // cards (landscape in real life) get center-cropped rather than
  // breaking the grid rhythm — simpler and more predictable than
  // mixing orientations in a single grid.
  return (
    <div
      className={`group relative flex flex-col bg-space-800/60 rounded-md overflow-hidden border ${missingPrice ? 'border-red-500/60' : 'border-space-700'}`}
      title={`${tc.card.name}${tc.qty > 1 ? ` × ${tc.qty}` : ''}`}
    >
      <div className="relative w-full aspect-[5/7] bg-space-900 overflow-hidden">
        <CardThumb
          productId={tc.card.productId}
          name={tc.card.name}
          size="md"
          className="w-full h-full"
        />
        {tc.qty > 1 && (
          <span className={`absolute top-1 right-1 min-w-[22px] h-[18px] px-1.5 rounded-full flex items-center justify-center text-[10px] font-bold tabular-nums shadow-lg ${qtyBg}`}>
            ×{tc.qty}
          </span>
        )}
        {missingPrice && (
          <span className="absolute top-1 left-1 w-5 h-5 rounded-full bg-red-900/90 text-red-200 flex items-center justify-center shadow-lg" title="No price">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </span>
        )}
      </div>
      <div className="px-1.5 py-1 leading-tight">
        <div className="text-[10px] text-gray-300 truncate">{extractBaseName(tc.card.name)}</div>
        <VariantBadge
          variant={extractVariantLabel(tc.card.name)}
          size="xs"
          className="inline-block max-w-full truncate align-middle"
        />
        <div className={`text-[11px] font-bold tabular-nums ${missingPrice ? 'text-red-400' : 'text-gold'}`}>
          {formatPrice(lineTotal)}
        </div>
      </div>
    </div>
  );
}

function SidePanel({ cards, percentage, priceMode, label, accentColor }: {
  cards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
  label: string;
  accentColor: 'emerald' | 'blue';
}) {
  const total = calcTotal(cards, percentage, priceMode);
  const labelColor = accentColor === 'emerald' ? 'text-emerald-300' : 'text-blue-300';
  const borderColor = accentColor === 'emerald' ? 'border-emerald-500/20' : 'border-blue-500/20';
  const saberGradient = accentColor === 'emerald'
    ? 'bg-gradient-to-b from-emerald-300 via-emerald-500 to-emerald-700 shadow-[0_0_10px_rgba(52,211,153,0.55)]'
    : 'bg-gradient-to-b from-blue-300 via-blue-500 to-blue-700 shadow-[0_0_10px_rgba(96,165,250,0.55)]';

  // Grid of card tiles. Column count adapts to card count so small
  // trades don't look tiny and large trades stay one-screen.
  const gridCols = cards.length <= 6
    ? 'grid-cols-3 sm:grid-cols-3 md:grid-cols-4'
    : cards.length <= 12
      ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5'
      : 'grid-cols-4 sm:grid-cols-5 md:grid-cols-6';

  return (
    <div className={`relative bg-space-800/80 rounded-xl border ${borderColor} overflow-hidden`}>
      <div className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-full ${saberGradient}`} aria-hidden />
      <div className="flex items-center justify-between pl-5 pr-4 py-2.5 border-b border-space-700">
        <span className={`swu-display text-xs ${labelColor}`}>{label}</span>
        <span className="text-base font-bold tabular-nums text-gray-100">{formatPrice(total)}</span>
      </div>
      {cards.length === 0 ? (
        <div className="px-5 py-6 text-gray-600 text-sm text-center">No cards</div>
      ) : (
        <div className={`grid ${gridCols} gap-2 p-3`}>
          {cards.map(tc => {
            const key = tradeCardKey(tc.card);
            return (
              <SummaryTile
                key={key}
                tc={tc}
                percentage={percentage}
                priceMode={priceMode}
                accentColor={accentColor}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TradeSummary({ yourCards, theirCards, onClose }: TradeSummaryProps) {
  const { user } = useAuthContext();
  const { percentage, setPercentage, priceMode, setPriceMode } = usePricing();
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [pickerOpen, setPickerOpen] = useState(false);
  const hasAnyCards = yourCards.length > 0 || theirCards.length > 0;

  /**
   * Navigate into the proposal composer carrying the current cards via
   * the URL's trade codec. ProposeBar's one-shot auto-apply effect only
   * fires when both sides are empty at mount (see ProposeBar.tsx
   * autoAppliedRef), so cards already in the URL survive unchanged and
   * the recipient just sees what the sender composed locally.
   */
  const handleProposeTo = useCallback((handle: string) => {
    const search = buildTradeSearch({ yourCards, theirCards, percentage, priceMode });
    const params = new URLSearchParams(search);
    params.set('propose', handle);
    window.location.href = `/?${params.toString()}`;
  }, [yourCards, theirCards, percentage, priceMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const yourTotal = calcTotal(yourCards, percentage, priceMode);
  const theirTotal = calcTotal(theirCards, percentage, priceMode);
  const isEmpty = yourCards.length === 0 && theirCards.length === 0;
  const balance = computeBalance(yourTotal, theirTotal, isEmpty);
  const chrome = balanceChrome(balance.tone);
  const missingCount = countMissingPrices(yourCards, priceMode) + countMissingPrices(theirCards, priceMode);

  // Thematic action line, matching the pattern in the bottom balance bar.
  const handleSave = useCallback(async () => {
    if (!user || saveState === 'saving' || saveState === 'saved') return;
    setSaveState('saving');
    try {
      const snapshot = (cards: TradeCard[]) =>
        cards.map(tc => ({
          productId: tc.card.productId ?? '',
          name: extractBaseName(tc.card.name),
          variant: extractVariantLabel(tc.card.name),
          qty: tc.qty,
          unitPrice: adjustPrice(getCardPrice(tc.card, priceMode), percentage),
        }));
      await fetch('/api/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          yourCards: snapshot(yourCards),
          theirCards: snapshot(theirCards),
          percentage,
          priceMode,
          totalYours: yourTotal,
          totalTheirs: theirTotal,
        }),
      });
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [user, saveState, yourCards, theirCards, percentage, priceMode, yourTotal, theirTotal]);

  let actionLine: React.ReactNode = null;
  if (balance.tier !== 'balanced' && balance.absDiff >= 0.01) {
    const amount = formatPrice(balance.absDiff);
    const verb = balance.favored === 'them' ? 'Ask for' : 'Offer';
    actionLine = (
      <>
        {verb}{' '}
        <span className={`font-bold tabular-nums ${chrome.headline}`}>{amount}</span>
        {' '}more to restore balance
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-space-900/95 flex flex-col animate-fade-in">
      {/* Thin header strip — width-matched to the content below so
          the back/share/pricing controls don't hang past the edges. */}
      <div className="shrink-0 flex items-center justify-between max-w-6xl mx-auto w-full px-4 pt-3 pb-2">
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-200 transition-colors p-1.5 -ml-1.5 flex items-center gap-1.5 text-sm"
          aria-label="Close summary"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
          <span className="hidden sm:inline">Back</span>
        </button>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg bg-space-800/60 border border-space-700">
            <PriceModeToggle value={priceMode} onChange={setPriceMode} />
            <span className="w-px h-5 bg-space-700" aria-hidden />
            <PriceSlider value={percentage} onChange={setPercentage} />
          </div>
          {/* Desktop shows inline Link/Image pills; mobile collapses
              them into a kebab to save header width. */}
          <div className="hidden md:block">
            <ShareButtons />
          </div>
          <div className="md:hidden">
            <MobileActionsKebab />
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 pb-6 pt-2 sm:pt-4">
          {/* Compact balance strip — mirrors the bottom banner's pattern
              (headline + action + color-coded totals). Stacks vertically
              on mobile so the headline gets full banner width, flows
              side-by-side on sm+. */}
          <div className={`rounded-lg border ${chrome.border} ${chrome.bg} px-4 py-3 mb-4 ${balance.tier === 'chaos' ? 'animate-pulse-crimson' : ''}`}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <div className="min-w-0">
                <div className={`swu-display text-xs sm:text-sm ${chrome.headline}`}>
                  {balance.headline}
                </div>
                {actionLine && (
                  <div className="text-[11px] sm:text-xs text-gray-300 mt-0.5">
                    {actionLine}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 text-[11px] tabular-nums shrink-0">
                <span className="flex items-baseline gap-1">
                  <span className="text-emerald-400/70 uppercase text-[9px] tracking-widest font-semibold">Offer</span>
                  <span className="text-emerald-200 font-semibold">{formatPrice(yourTotal)}</span>
                </span>
                <span className="text-space-600" aria-hidden>·</span>
                <span className="flex items-baseline gap-1">
                  <span className="text-blue-400/70 uppercase text-[9px] tracking-widest font-semibold">Receive</span>
                  <span className="text-blue-200 font-semibold">{formatPrice(theirTotal)}</span>
                </span>
              </div>
            </div>
          </div>

          {/* Signed-in action row — Save + Send-as-proposal, side by side.
              Both act on the current in-builder trade. Save persists it
              to the viewer's own trades history; Send-as-proposal opens
              the handle picker, then navigates to the compose flow with
              the current cards preserved via URL state. */}
          {user && hasAnyCards && (
            <div className="mb-4 flex justify-center flex-wrap gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saveState === 'saving' || saveState === 'saved'}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wide transition-colors ${
                  saveState === 'saved'
                    ? 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-300'
                    : saveState === 'error'
                      ? 'bg-red-500/15 border border-red-500/40 text-red-300 hover:bg-red-500/25'
                      : 'bg-space-800/60 border border-space-700 text-gray-300 hover:border-gold/40 hover:text-gold'
                }`}
              >
                {saveState === 'saved' ? (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                    Saved
                  </>
                ) : saveState === 'saving' ? (
                  'Saving…'
                ) : saveState === 'error' ? (
                  'Retry save'
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>
                    Save this trade
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wide bg-gold/15 border border-gold/40 text-gold hover:bg-gold/25 hover:border-gold/60 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
                </svg>
                Send as proposal
              </button>
            </div>
          )}

          {missingCount > 0 && (
            <div className="mb-4 mx-auto max-w-md flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-red-950/60 border border-red-500/60 text-xs font-bold text-red-300">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <span>
                {missingCount} card{missingCount === 1 ? '' : 's'} missing price — balance is incomplete
              </span>
            </div>
          )}

          {/* Two-panel receipt — card tiles inside each side, so big
              trades fit without scrolling and card art is visible. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <SidePanel cards={yourCards} percentage={percentage} priceMode={priceMode} label="Offering" accentColor="emerald" />
            <SidePanel cards={theirCards} percentage={percentage} priceMode={priceMode} label="Receiving" accentColor="blue" />
          </div>

        </div>
      </div>

      <HandlePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handle => {
          setPickerOpen(false);
          handleProposeTo(handle);
        }}
      />
    </div>
  );
}
