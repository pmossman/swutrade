import { useState, useCallback, useEffect, useMemo } from 'react';
import type { CardVariant, TradeCard, PriceMode } from './types';
import { SETS, tradeCardKey } from './types';
import { PriceModeToggle } from './components/PriceModeToggle';
import { SetFilter } from './components/SetFilter';
import { PriceSlider } from './components/PriceSlider';
import { TradeSide } from './components/TradeSide';
import { TradeBalance } from './components/TradeBalance';
import { TradeSummary } from './components/TradeSummary';
import { usePriceData } from './hooks/usePriceData';

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
  const [percentage, setPercentage] = useState(80);
  const [priceMode, setPriceMode] = useState<PriceMode>('market');
  const [setFilter, setSetFilter] = useState<string | null>(null);
  const [yourCards, setYourCards] = useState<TradeCard[]>([]);
  const [theirCards, setTheirCards] = useState<TradeCard[]>([]);
  const [showSummary, setShowSummary] = useState(false);

  const priceData = usePriceData();

  // Load all sets on mount (static files are fast from CDN)
  useEffect(() => {
    priceData.loadAllSets();
  }, [priceData.loadAllSets]);

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

  const handleSetChange = useCallback((slug: string | null) => {
    setSetFilter(slug);
    if (slug) {
      const set = SETS.find(s => s.slug === slug);
      if (set) priceData.loadSet(set);
    }
  }, [priceData]);

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
      {/* Top bar */}
      <div className="px-3 pt-3 pb-2 max-w-5xl mx-auto w-full shrink-0">
        <div className="flex items-center justify-between mb-2.5">
          <h1 className="swu-title text-xl">
            SWU TRADE
          </h1>
          {hasCards && (
            <button
              onClick={handleClear}
              className="text-[11px] text-gray-500 hover:text-red-400 transition-colors px-2 py-1 rounded"
            >
              Clear All
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <SetFilter value={setFilter} onChange={handleSetChange} />
          <PriceModeToggle value={priceMode} onChange={setPriceMode} />
          <PriceSlider value={percentage} onChange={setPercentage} />
          {priceData.isAnyLoading ? (
            <span className="text-[11px] text-gray-500 animate-pulse">Loading...</span>
          ) : priceData.priceTimestamp && (
            <span className="text-[10px] text-gray-600" title={`Prices updated ${priceData.priceTimestamp}`}>
              Prices: {timeAgo(priceData.priceTimestamp)}
            </span>
          )}
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
            label="You"
            cards={yourCards}
            percentage={percentage}
            priceMode={priceMode}
            onAdd={handleAddYour}
            onRemove={handleRemoveYour}
            onChangeQty={handleQtyYour}
            accentColor="emerald"
            borderColor="border-emerald-500/20"
            setCards={priceData.cards}
            setFilter={setFilter}
            isLoading={priceData.isAnyLoading}
            onLoadAllSets={handleLoadAllSets}
          />
          <TradeSide
            label="Them"
            cards={theirCards}
            percentage={percentage}
            priceMode={priceMode}
            onAdd={handleAddTheir}
            onRemove={handleRemoveTheir}
            onChangeQty={handleQtyTheir}
            accentColor="blue"
            borderColor="border-blue-500/20"
            setCards={priceData.cards}
            setFilter={setFilter}
            isLoading={priceData.isAnyLoading}
            onLoadAllSets={handleLoadAllSets}
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
          onClose={() => setShowSummary(false)}
        />
      )}

      {/* Footer */}
      <div className="shrink-0 pb-2 text-center text-[10px] text-gray-600">
        <div>
          Created by Parker Mossman
          {' · '}
          <a
            href="https://discord.com/users/pmoss"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-gold transition-colors underline"
          >
            @pmoss
          </a>
          {' on Discord'}
        </div>
        <div className="mt-0.5 hidden md:block">
          Prices from{' '}
          <a
            href="https://www.tcgplayer.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-gold transition-colors underline"
          >
            TCGPlayer
          </a>
        </div>
      </div>
    </div>
  );
}

export default App;
