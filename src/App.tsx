import { useState, useCallback, useEffect, useMemo } from 'react';
import type { CardVariant, TradeCard, PriceMode } from './types';
import { SETS, tradeCardKey } from './types';
import { PriceModeToggle } from './components/PriceModeToggle';
import { PriceSlider } from './components/PriceSlider';
import { TradeSide } from './components/TradeSide';
import { TradeBalance } from './components/TradeBalance';
import { TradeSummary } from './components/TradeSummary';
import { ShareButtons } from './components/ShareButtons';
import { Logo } from './components/Logo';
import { ClearAllButton } from './components/ClearAllButton';
import { usePriceData } from './hooks/usePriceData';
import { useSearchFilters } from './hooks/useVariantFilter';
import { useTradeUrl } from './hooks/useTradeUrl';
import { usePersistedState } from './hooks/usePersistedState';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function App() {
  // Persist the user's preferred pricing knobs across sessions. The raw
  // setters bypass localStorage so URL-driven updates (share links,
  // back/forward) don't clobber the saved preference.
  const [percentage, setPercentage, setPercentageRaw] = usePersistedState<number>(
    'swu.pct',
    80,
    raw => {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 1 && n <= 100 ? n : null;
    },
  );
  const [priceMode, setPriceMode, setPriceModeRaw] = usePersistedState<PriceMode>(
    'swu.pm',
    'market',
    raw => (raw === 'market' || raw === 'low' ? raw : null),
  );
  const [yourCards, setYourCards] = useState<TradeCard[]>([]);
  const [theirCards, setTheirCards] = useState<TradeCard[]>([]);
  const [showSummary, setShowSummary] = useState(false);

  const priceData = usePriceData();
  // Single shared filter-state instance so both trade sides see the
  // same scope toggle + variant/set hide preferences in real time.
  const filters = useSearchFilters();

  // Load all sets on mount (static files are fast from CDN)
  useEffect(() => {
    priceData.loadAllSets();
  }, [priceData.loadAllSets]);

  // Sync trade state to/from URL for sharing and back/forward navigation
  const allLoadedCards = useMemo(() => Object.values(priceData.cards).flat(), [priceData.cards]);
  useTradeUrl(
    { yourCards, theirCards, percentage, priceMode },
    allLoadedCards,
    setYourCards,
    setTheirCards,
    setPercentageRaw,
    setPriceModeRaw,
  );

  // --- Card management helpers (qty-aware) ---

  const addCard = useCallback((setter: React.Dispatch<React.SetStateAction<TradeCard[]>>) => {
    return (card: CardVariant) => {
      setter(prev => {
        const key = tradeCardKey(card);
        const existing = prev.find(tc => tradeCardKey(tc.card) === key);
        if (existing) {
          return prev.map(tc =>
            tradeCardKey(tc.card) === key ? { ...tc, qty: tc.qty + 1 } : tc
          );
        }
        return [...prev, { card, qty: 1 }];
      });
    };
  }, []);

  const changeQty = useCallback((setter: React.Dispatch<React.SetStateAction<TradeCard[]>>) => {
    return (key: string, delta: number) => {
      setter(prev =>
        prev
          .map(tc => tradeCardKey(tc.card) === key ? { ...tc, qty: tc.qty + delta } : tc)
          .filter(tc => tc.qty > 0)
      );
    };
  }, []);

  const removeCard = useCallback((setter: React.Dispatch<React.SetStateAction<TradeCard[]>>) => {
    return (key: string) => {
      setter(prev => prev.filter(tc => tradeCardKey(tc.card) !== key));
    };
  }, []);

  const handleAddYour = useMemo(() => addCard(setYourCards), [addCard]);
  const handleAddTheir = useMemo(() => addCard(setTheirCards), [addCard]);
  const handleQtyYour = useMemo(() => changeQty(setYourCards), [changeQty]);
  const handleQtyTheir = useMemo(() => changeQty(setTheirCards), [changeQty]);
  const handleRemoveYour = useMemo(() => removeCard(setYourCards), [removeCard]);
  const handleRemoveTheir = useMemo(() => removeCard(setTheirCards), [removeCard]);

  const handleLoadAllSets = useCallback(() => {
    priceData.loadAllSets();
  }, [priceData]);

  const hasCards = yourCards.length > 0 || theirCards.length > 0;

  const handleClear = useCallback(() => {
    setYourCards([]);
    setTheirCards([]);
  }, []);

  return (
    <div className="h-[100dvh] bg-space-900 text-gray-100 flex flex-col overflow-hidden">
      {/* Top bar — single row: logo | scope + pricing controls | actions */}
      <div className="px-3 pt-3 pb-2 max-w-5xl mx-auto w-full shrink-0">
        <div className="flex items-center gap-x-8 gap-y-2 flex-wrap">
          <h1 className="flex items-center gap-2.5 select-none shrink-0">
            <Logo className="w-9 h-9 shrink-0" />
            <span className="text-sm font-bold text-gray-200 tracking-[0.12em] leading-none">
              <span className="uppercase">SWU</span><span className="text-gold uppercase">Trade</span><span className="text-[11px] text-gray-500 font-medium">.com</span>
            </span>
          </h1>
          <div className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg bg-space-800/60 border border-space-700">
            <PriceModeToggle value={priceMode} onChange={setPriceMode} />
            <span className="w-px h-5 bg-space-700" aria-hidden />
            <PriceSlider value={percentage} onChange={setPercentage} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            {hasCards && <ShareButtons size="sm" />}
            {hasCards && <ClearAllButton onConfirm={handleClear} />}
          </div>
        </div>
      </div>

      {/* Error messages */}
      <div className="px-3 max-w-5xl mx-auto w-full shrink-0">
        {Object.entries(priceData.errors).map(([slug, error]) =>
          error ? (
            <div key={slug} className="mb-2 p-2 bg-red-900/20 border border-red-800/30 rounded-lg text-xs text-red-300">
              Failed to load {slug}: {error}
              <button
                onClick={() => {
                  const set = SETS.find(s => s.slug === slug);
                  if (set) priceData.retrySet(set);
                }}
                className="ml-2 underline hover:text-red-200"
              >
                Retry
              </button>
            </div>
          ) : null
        )}
      </div>

      {/* Trade panels — the main content, fills remaining viewport */}
      <div className="flex-1 min-h-0 px-3 pb-2 max-w-5xl mx-auto w-full">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 h-full">
          <TradeSide
            label="Offering"
            cards={yourCards}
            percentage={percentage}
            priceMode={priceMode}
            onAdd={handleAddYour}
            onRemove={handleRemoveYour}
            onChangeQty={handleQtyYour}
            accentColor="emerald"
            borderColor="border-emerald-500/20"
            setCards={priceData.cards}
            isLoading={priceData.isAnyLoading}
            onLoadAllSets={handleLoadAllSets}
            onPriceModeChange={setPriceMode}
            filters={filters}
          />
          <TradeSide
            label="Receiving"
            cards={theirCards}
            percentage={percentage}
            priceMode={priceMode}
            onAdd={handleAddTheir}
            onRemove={handleRemoveTheir}
            onChangeQty={handleQtyTheir}
            accentColor="blue"
            borderColor="border-blue-500/20"
            setCards={priceData.cards}
            isLoading={priceData.isAnyLoading}
            onLoadAllSets={handleLoadAllSets}
            onPriceModeChange={setPriceMode}
            filters={filters}
          />
        </div>
      </div>

      {/* Balance bar at bottom */}
      <div className="shrink-0 px-3 pb-3 pt-2 max-w-5xl mx-auto w-full">
        {hasCards ? (
          <button
            onClick={() => setShowSummary(true)}
            className="w-full text-left active:scale-[0.98] transition-transform"
          >
            <TradeBalance
              yourCards={yourCards}
              theirCards={theirCards}
              percentage={percentage}
              priceMode={priceMode}
            />
          </button>
        ) : (
          <TradeBalance
            yourCards={yourCards}
            theirCards={theirCards}
            percentage={percentage}
            priceMode={priceMode}
          />
        )}
      </div>

      {/* Trade summary overlay */}
      {showSummary && (
        <TradeSummary
          yourCards={yourCards}
          theirCards={theirCards}
          percentage={percentage}
          priceMode={priceMode}
          onPriceModeChange={setPriceMode}
          onPercentageChange={setPercentage}
          onClose={() => setShowSummary(false)}
        />
      )}

      {/* Footer */}
      <div className="shrink-0 pb-2 text-center text-[10px] text-gray-600">
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <span>
            Created by{' '}
            <a
              href="https://discord.com/users/pmoss"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-gold transition-colors underline"
            >
              @pmoss
            </a>
          </span>
          <span className="text-space-600" aria-hidden>·</span>
          <span>
            Prices from{' '}
            <a
              href="https://www.tcgplayer.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-gold transition-colors underline"
            >
              TCGPlayer
            </a>
          </span>
          {priceData.isAnyLoading ? (
            <>
              <span className="text-space-600" aria-hidden>·</span>
              <span className="text-gray-500 animate-pulse">Loading prices…</span>
            </>
          ) : priceData.priceTimestamp && (
            <>
              <span className="text-space-600" aria-hidden>·</span>
              <span title={`Prices updated ${priceData.priceTimestamp}`}>
                Updated {timeAgo(priceData.priceTimestamp)}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
