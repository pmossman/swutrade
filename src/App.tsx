import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
import { MobileActionsKebab } from './components/MobileActionsKebab';
import { PanelDivider } from './components/PanelDivider';
import { ListsDrawer } from './components/ListsDrawer';
import { BetaBadge } from './components/BetaBadge';
import { useWants } from './hooks/useWants';
import { useAvailable } from './hooks/useAvailable';
import { APP_COMMIT, APP_BUILD_TIME, isBetaChannel } from './version';
import { usePriceData } from './hooks/usePriceData';
import { useSearchFilters } from './hooks/useVariantFilter';
import { useIsMobile } from './hooks/useMediaQuery';
import { useTradeUrl } from './hooks/useTradeUrl';
import { usePersistedState } from './hooks/usePersistedState';
import {
  PERSIST_KEYS,
  PercentageSchema,
  PriceModeSchema,
  DEFAULTS,
} from './persistence';

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
  const [percentage, setPercentage, setPercentageRaw] = usePersistedState(
    PERSIST_KEYS.percentage,
    PercentageSchema,
    DEFAULTS.percentage,
  );
  const [priceMode, setPriceMode, setPriceModeRaw] = usePersistedState<PriceMode>(
    PERSIST_KEYS.priceMode,
    PriceModeSchema,
    DEFAULTS.priceMode,
  );
  const [yourCards, setYourCards] = useState<TradeCard[]>([]);
  const [theirCards, setTheirCards] = useState<TradeCard[]>([]);
  const [showSummary, setShowSummary] = useState(false);
  // Per-panel collapse state — lets mobile users shrink a side they're
  // not editing so the other gets more scroll room.
  const [offeringCollapsed, setOfferingCollapsed] = useState(false);
  const [receivingCollapsed, setReceivingCollapsed] = useState(false);
  // Mobile-only: manual split ratio between Offering and Receiving
  // panels (0 = all Receiving, 1 = all Offering). Null = auto.
  const [splitRatio, setSplitRatio] = useState<number | null>(null);
  const panelsRef = useRef<HTMLDivElement>(null);
  const [bannerCollapsed, setBannerCollapsed] = useState(() => {
    // Default-collapsed on mobile so the banner doesn't compete with
    // the card lists for vertical space. User can expand anytime.
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });

  const priceData = usePriceData();
  // Single shared filter-state instance so both trade sides see the
  // same scope toggle + variant/set hide preferences in real time.
  const filters = useSearchFilters();
  const wants = useWants();
  const available = useAvailable();
  // Collapse controls are a mobile concern — side-by-side panels on
  // desktop don't benefit from collapsing either side.
  const isMobile = useIsMobile();

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
    <>
    <div className="h-[100dvh] bg-space-900 text-gray-100 flex flex-col overflow-hidden">
      {/* Top bar — logo | pricing pill | actions. All on one row.
          Mobile hides the wordmark and collapses Share/Clear into a
          single kebab so everything fits in a single 390px viewport. */}
      <div className="px-3 pt-3 pb-2 max-w-5xl mx-auto w-full shrink-0">
        <div className="flex items-center gap-3 md:gap-4">
          <h1 className="flex items-center gap-2 select-none shrink-0">
            {/* Logo sits flush against the "S" — the tiny gap after
                the logo should match the inter-letter tracking so
                it reads as a glyph in the word, not a separate icon. */}
            <span className="flex items-center">
              <Logo className="w-6 h-6 sm:w-7 sm:h-7 shrink-0" />
              <span className="ml-px text-sm sm:text-lg font-bold tracking-[0.1em] sm:tracking-[0.12em] leading-none">
                <span className="text-gray-200 uppercase">SWU</span><span className="text-gold uppercase">Trade</span>
              </span>
            </span>
            <BetaBadge />
          </h1>
          {/* Controls cluster — pricing + actions grouped together and
              pushed to the right (ml-auto) so the logo/title gets
              breathing room on the left. */}
          <div className="ml-auto flex items-center gap-2">
            <ListsDrawer
              wants={wants}
              available={available}
              allCards={allLoadedCards}
              percentage={percentage}
              priceMode={priceMode}
            />
            <div className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg bg-space-800/60 border border-space-700">
              <PriceModeToggle value={priceMode} onChange={setPriceMode} />
              <span className="w-px h-5 bg-space-700" aria-hidden />
              <PriceSlider value={percentage} onChange={setPercentage} />
            </div>
            {hasCards && (
              <>
                {/* Desktop: inline pills. Mobile: single kebab. */}
                <div className="hidden md:flex items-center gap-2">
                  <ShareButtons size="sm" />
                  <ClearAllButton onConfirm={handleClear} />
                </div>
                <div className="md:hidden">
                  <MobileActionsKebab onClear={handleClear} />
                </div>
              </>
            )}
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

      {/* Trade panels — flex on mobile so a collapsed panel gives its
          space to the expanded one. Grid on md+ keeps side-by-side. */}
      <div className="flex-1 min-h-0 px-3 pb-2 max-w-5xl mx-auto w-full">
        <div ref={panelsRef} className="flex flex-col md:grid md:grid-cols-2 gap-3 h-full">
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
            collapsed={isMobile && offeringCollapsed}
            onToggleCollapse={isMobile ? () => setOfferingCollapsed(c => !c) : undefined}
            flexBasis={!isMobile || offeringCollapsed || receivingCollapsed ? undefined : (splitRatio ?? undefined)}
          />
          {/* Mobile-only drag handle between the two panels. Collapsed
              panels hide the divider — nothing to resize against. */}
          {!offeringCollapsed && !receivingCollapsed && (
            <PanelDivider containerRef={panelsRef} onRatioChange={setSplitRatio} />
          )}
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
            collapsed={isMobile && receivingCollapsed}
            onToggleCollapse={isMobile ? () => setReceivingCollapsed(c => !c) : undefined}
            flexBasis={!isMobile || offeringCollapsed || receivingCollapsed || splitRatio === null ? undefined : 1 - splitRatio}
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
              collapsed={isMobile && bannerCollapsed}
              onToggleCollapse={isMobile ? () => setBannerCollapsed(c => !c) : undefined}
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
      <div className="shrink-0 pb-2 px-3 text-center text-[10px] text-gray-600 max-w-5xl mx-auto w-full">
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
                Prices updated {timeAgo(priceData.priceTimestamp)}
              </span>
            </>
          )}
          <span className="text-space-600" aria-hidden>·</span>
          <span
            title={`Built ${new Date(APP_BUILD_TIME).toLocaleString()}`}
            className={isBetaChannel() ? 'text-gold/70' : 'text-gray-500'}
          >
            {isBetaChannel() ? 'beta' : 'v'}&nbsp;{APP_COMMIT}
          </span>
        </div>
        {/* Legal/attribution line — visible inline on desktop, but
            pushed below the fold on mobile so we don't eat the main
            vertical space. Scroll down on mobile to read it. */}
        <div className="hidden md:block mt-1.5 text-[9px] text-gray-700 leading-snug px-2">
          SWUTrade is an unofficial fan site, not produced or endorsed by Fantasy Flight Publishing or Lucasfilm Ltd.
          Card images and Star Wars: Unlimited game assets © Fantasy Flight Publishing Inc. and Lucasfilm Ltd.
          Card prices are estimates — see stores for final pricing.
        </div>
      </div>
    </div>
    {/* Mobile-only legal disclaimer pushed BELOW the 100dvh viewport
        so it doesn't eat main-app vertical space. Scroll down to see. */}
    <div className="md:hidden bg-space-900 text-gray-700 text-[10px] leading-snug px-4 py-4 text-center">
      SWUTrade is an unofficial fan site, not produced or endorsed by Fantasy Flight Publishing or Lucasfilm Ltd.
      Card images and Star Wars: Unlimited game assets © Fantasy Flight Publishing Inc. and Lucasfilm Ltd.
      Card prices are estimates — see stores for final pricing.
    </div>
    </>
  );
}

export default App;
