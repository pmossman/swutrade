import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { CardVariant, TradeCard, PriceMode } from './types';
import { SETS, tradeCardKey } from './types';
import { TradeSide } from './components/TradeSide';
import { TradeBalance } from './components/TradeBalance';
import { TradeSummary } from './components/TradeSummary';
import { ShareButtons } from './components/ShareButtons';
import { ShareLiveTradeButton } from './components/ShareLiveTradeButton';
import { ClearAllButton } from './components/ClearAllButton';
import { MobileActionsKebab } from './components/MobileActionsKebab';
import { PanelDivider } from './components/PanelDivider';
import { ListsDrawer } from './components/ListsDrawer';
import { AppHeader } from './components/ui/AppHeader';
import { useWants } from './hooks/useWants';
import { useAvailable } from './hooks/useAvailable';
import { useSharedLists } from './hooks/useSharedLists';
import { useRecipientProfile } from './hooks/useRecipientProfile';
import { useTradeViewMode } from './hooks/useTradeViewMode';
import { adjustPrice, getCardPrice } from './services/priceService';
import { useTradeIntent } from './hooks/useTradeIntent';
import { useCommunityCards } from './hooks/useCommunityCards';
import { ListView } from './components/ListView';
import { APP_COMMIT, APP_BUILD_TIME, isBetaChannel } from './version';
import { useSelectionFilters } from './hooks/useSelectionFilters';
import { useIsMobile } from './hooks/useMediaQuery';
import { useTradeUrl } from './hooks/useTradeUrl';
import { PERSIST_KEYS } from './persistence';
import { useAuthContext } from './contexts/AuthContext';
import { usePriceDataContext } from './contexts/PriceDataContext';
import { useCardIndexContext } from './contexts/CardIndexContext';
import { useDrawerContext } from './contexts/DrawerContext';
import { usePricing } from './contexts/PricingContext';
import { useServerSync } from './hooks/useServerSync';
import { MigrationDialog } from './components/MigrationDialog';
import { ProfileView } from './components/ProfileView';
import { AutoBalanceBanner } from './components/AutoBalanceBanner';
import { SettingsView } from './components/SettingsView';
import { CommunityView } from './components/CommunityView';
import { HomeView } from './components/HomeView';
import { ProposeBar } from './components/ProposeBar';
import { CounterBar } from './components/CounterBar';
import { EditBar } from './components/EditBar';
import { TradeDetailView } from './components/TradeDetailView';
import { TradesHistoryView } from './components/TradesHistoryView';
import { SessionView } from './components/SessionView';
import { detectViewMode, VIEW_PARAM_KEYS, type ViewMode } from './routing/config';
import { NavigationProvider, type NavigationApi } from './contexts/NavigationContext';

/** Extract the handle from either `?profile=<handle>` or the
 *  `/u/<handle>` pathname — whichever the user navigated via. */
function readProfileHandle(): string {
  if (typeof window === 'undefined') return '';
  const fromQuery = new URLSearchParams(window.location.search).get('profile');
  if (fromQuery) return fromQuery;
  const m = window.location.pathname.match(/^\/u\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

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
  const auth = useAuthContext();
  const { user, isSignedIn } = auth;

  // Pricing knobs live in PricingContext — state + persistence are
  // owned there so every view that renders a price can read them
  // without threading through props. Raw setters (bypass-localStorage)
  // are exposed for useTradeUrl's URL-restore path. App reads the
  // values for local calls (card-total calcs in TradeTabBar, etc.);
  // setters are consumed directly from context by TradeBalance +
  // TradeSummary where the pricing widgets live.
  const {
    percentage,
    setPercentageRaw,
    priceMode,
    setPriceModeRaw,
  } = usePricing();
  const [yourCards, setYourCards] = useState<TradeCard[]>([]);
  const [theirCards, setTheirCards] = useState<TradeCard[]>([]);
  const [showSummary, setShowSummary] = useState(false);
  // Per-panel collapse state — lets mobile users shrink a side they're
  // not editing so the other gets more scroll room.
  const [offeringCollapsed, setOfferingCollapsed] = useState(false);
  const [receivingCollapsed, setReceivingCollapsed] = useState(false);
  // ListsDrawer open-state lives on DrawerContext — one shared boolean
  // across all views means the drawer renders once at App root instead
  // of each view owning its own copy.
  const { listsDrawerOpen, openLists, setListsDrawerOpen } = useDrawerContext();
  // Per-device trade layout: split (default, both panels visible) or
  // tabbed (single-panel focus with OFFERING/RECEIVING tab bar).
  // Active tab is ephemeral session state — no reason to persist
  // "which tab did I last look at" across reloads.
  const { mode: tradeViewMode, toggle: toggleTradeView } = useTradeViewMode();
  const [activeTradeTab, setActiveTradeTab] = useState<'offering' | 'receiving'>('offering');
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

  const priceData = usePriceDataContext();
  const cardIndex = useCardIndexContext();
  // Single shared filter-state instance so both trade sides see the
  // same variant/set selection preferences in real time.
  const filters = useSelectionFilters({
    variants: PERSIST_KEYS.tradeSelVariants,
    sets: PERSIST_KEYS.tradeSelSets,
  });
  const wants = useWants();
  const available = useAvailable();
  const { status: syncStatus, migrationPrompt } = useServerSync(wants, available, user);
  const sharedLists = useSharedLists();
  // Unified intent store: owns ?propose / ?from / ?counter / ?edit /
  // ?autoBalance. Seeded from URL on mount + re-syncs on popstate;
  // in-app navigation helpers below call `intent.setIntent({...})`
  // alongside their pushState write so state and URL stay aligned
  // even when React doesn't remount.
  const intent = useTradeIntent();
  const { propose: proposeHandle, from: senderHandle, counter: counterId, edit: editId } = intent;
  // When proposing to a specific user, fetch their public lists here
  // so both ProposeBar (matchmaker + status hint) and TradeSide
  // (scoped picker source chips) read the same snapshot without
  // double-fetching. `sharedLists` (the ?w=/?a= URL-encoded form)
  // remains the fallback for the share-a-list flow — propose mode
  // takes precedence when active.
  const { profile: recipientProfile, fetchState: recipientFetchState } = useRecipientProfile(proposeHandle);
  const effectiveSharedLists = useMemo(() => {
    if (proposeHandle && recipientProfile) {
      return {
        wants: recipientProfile.wants ?? [],
        available: recipientProfile.available ?? [],
      };
    }
    return sharedLists;
  }, [proposeHandle, recipientProfile, sharedLists]);
  // Phase 4 community rollup — signed-in users see an extra
  // "Community wants/has" chip in the picker, scoped to cards other
  // members of their enrolled Discord guilds want or have.
  const community = useCommunityCards(!!user);
  // Collapse controls are a mobile concern — side-by-side panels on
  // desktop don't benefit from collapsing either side.
  const isMobile = useIsMobile();

  // View mode: list-view is the default landing for shared-link URLs
  // (lists in URL but no trade). Users opt into the trade UI via the
  // "Start a trade" CTA on the list view, which appends ?view=trade.
  // ?view=list / ?view=trade explicitly overrides the heuristic.
  // Seed from `isSignedIn` (not `!!user`) so the first render uses the
  // localStorage signed-in hint. Without that, a returning user's URL
  // briefly resolves to the trade-builder default before /api/auth/me
  // lands and we flip to 'home' — a visible flash. See useAuth.ts.
  const [viewMode, setViewMode] = useState<ViewMode>(() => detectViewMode(isSignedIn));
  // Signals that the user just clicked "Start a trade" from the
  // shared-list view. Offering-side TradeSide reads this on mount to
  // auto-open its search overlay with the "From the shared link"
  // section expanded, dropping the user straight into picking cards
  // from the sender's wants. One-shot — cleared after the TradeSide
  // consumes it.
  const [autoOpenOfferingFromShared, setAutoOpenOfferingFromShared] = useState(false);
  // Keep a live ref of the signed-in flag so popstate (which fires
  // well after mount) reads the current value, not a stale closure.
  const isSignedInRef = useRef(isSignedIn);
  useEffect(() => {
    isSignedInRef.current = isSignedIn;
  }, [isSignedIn]);
  useEffect(() => {
    const handler = () => setViewMode(detectViewMode(isSignedInRef.current));
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
  // When auth resolves after first paint (signed-in user, bare URL),
  // flip the implicit default from 'trade' to 'home'. We only rewrite
  // when the URL is bare — explicit ?view=trade / shared list / trade
  // detail are all honoured.
  //
  // Depends on `isSignedIn` (not `user`) so a stale hint that resolves
  // to "actually signed out" still re-runs and flips us back to
  // 'trade'. Without that extra beat, the false hint would strand us
  // on 'home' even after the server confirms no session.
  useEffect(() => {
    setViewMode(prev => {
      // Only auto-switch between the two implicit defaults. Any
      // explicit view (settings, trade-detail, profile, etc.) stays.
      if (prev !== 'home' && prev !== 'trade') return prev;
      return detectViewMode(isSignedIn);
    });
  }, [isSignedIn]);
  const handleStartTrade = useCallback((fromHandle?: string, autoBalance?: boolean) => {
    const params = new URLSearchParams(window.location.search);
    params.set('view', 'trade');
    // Exit profile view when starting a trade from a profile page.
    // detectViewMode prioritizes ?profile= over ?view= so we have to
    // drop it, otherwise the view won't actually flip.
    params.delete('profile');
    // Carry the sender / viewed-profile handle forward as ?from= so
    // the matchmaker can pre-fill and the recipient-side features
    // (Phase 3b) can reference them.
    if (fromHandle) params.set('from', fromHandle);
    // autoBalance is a one-shot signal — "the user explicitly asked
    // for a balanced trade, apply it automatically when the banner
    // mounts". The banner strips it from the URL after applying so
    // reloads and shared URLs don't keep re-triggering.
    if (autoBalance) params.set('autoBalance', '1');
    else params.delete('autoBalance');
    // If we're currently on /u/<handle>, the new URL has to drop
    // the /u/ prefix explicitly — pushState without a pathname
    // keeps the current one, and detectViewMode prioritizes /u/ so
    // the trade view wouldn't actually flip on reload.
    const nextPath = window.location.pathname.startsWith('/u/') ? '/' : window.location.pathname;
    window.history.pushState(null, '', `${nextPath}?${params.toString()}`);
    // Mirror the URL write into the intent store. Without this, the
    // useTradeIntent state would stay at whatever was captured on
    // mount, and an in-session click to "Trade with @X" (pushState,
    // no reload) wouldn't populate senderHandle / autoBalance.
    intent.setIntent({
      from: fromHandle ?? null,
      autoBalance: !!autoBalance,
      // Starting a trade from a profile is a distinct intent from
      // propose/counter/edit — clear those so stale state can't leak
      // in from a previous in-session navigation.
      propose: null,
      counter: null,
      edit: null,
    });
    // Clear any persisted filter state so the sender's wants don't
    // land in an accidental "no matches" view if the user had a
    // narrow filter saved from an earlier session.
    filters.clearAll();
    setAutoOpenOfferingFromShared(true);
    setViewMode('trade');
  }, [filters, intent]);
  const consumeAutoOpenOffering = useCallback(() => {
    setAutoOpenOfferingFromShared(false);
  }, []);

  // Central navigation primitive. Every in-app navigation should flow
  // through one of these methods so URL + intent state + viewMode stay
  // in lockstep by construction — the class of bug that hit us on the
  // Home → Propose path (see aeb0aa2) can't recur through this seam.
  //
  // Each method uses the same three-step shape:
  //   1. Compute the next URLSearchParams (drop view-specific keys,
  //      set this view's keys).
  //   2. pushState the new URL.
  //   3. Update any React state that needs to track the destination:
  //      intent.setIntent for propose/from/counter/edit/autoBalance,
  //      setViewMode for the view flip, filters.clearAll where a
  //      trade builder needs to reset.
  // Views that don't touch trade intent (Home, Settings, Community,
  // Profile, trade-detail, trades-history) don't call setIntent —
  // those intents persist across view nav, which matches the "user
  // has an in-progress propose, peeks at Community" mental model.
  const nav = useMemo<NavigationApi>(() => {
    const pushTo = (next: URLSearchParams) => {
      const search = next.toString();
      const nextPath = window.location.pathname.startsWith('/u/') ? '/' : window.location.pathname;
      window.history.pushState(null, '', search ? `${nextPath}?${search}` : nextPath);
      setViewMode(detectViewMode(isSignedIn));
    };
    const reset = (keep: readonly string[], extras: Record<string, string> = {}) => {
      // Preserve any non-view param already in the URL (e.g. a trade
      // codec) that isn't explicitly dropped by this destination. Each
      // method lists the view params it "OWNS" and we drop everything
      // else in the view-param family. Trade-codec keys (y/t/pct/pm)
      // ride along untouched because useTradeUrl will rewrite them.
      const params = new URLSearchParams(window.location.search);
      // Always drop the full view-param family, then re-add what this
      // destination needs. Avoids stale `settings=1` surviving a
      // toHome() call.
      for (const key of VIEW_PARAM_KEYS) params.delete(key);
      for (const key of keep) {
        const current = new URLSearchParams(window.location.search).get(key);
        if (current !== null) params.set(key, current);
      }
      for (const [k, v] of Object.entries(extras)) params.set(k, v);
      return params;
    };
    return {
      toHome: () => {
        pushTo(reset([]));
        intent.clearIntent();
      },
      toBuildTrade: () => {
        // Clear propose/counter/edit so the composer opens clean. Keep
        // from+autoBalance if they're set — they represent the user's
        // current sender context (e.g. they were on "Trade with @X" and
        // clicked New trade from the same page).
        pushTo(reset([], { view: 'trade' }));
        intent.setIntent({ propose: null, counter: null, edit: null });
      },
      toProposeWith: handle => {
        pushTo(reset([], { propose: handle }));
        intent.setIntent({ propose: handle, counter: null, edit: null });
      },
      toStartTradeFrom: (fromHandle, autoBalance) => {
        handleStartTrade(fromHandle, autoBalance);
      },
      toTradeDetail: tradeId => {
        pushTo(reset([], { trade: tradeId }));
      },
      toTradesHistory: () => {
        pushTo(reset([], { trades: '1' }));
      },
      toSettings: (opts = {}) => {
        const extras: Record<string, string> = { settings: '1' };
        if (opts.tab) extras.tab = opts.tab;
        if (opts.guildId) extras.guild = opts.guildId;
        if (opts.memberHandle) extras.user = opts.memberHandle;
        pushTo(reset([], extras));
      },
      toCommunity: (opts = {}) => {
        const extras: Record<string, string> = { community: '1' };
        if (opts.guildId) extras.guild = opts.guildId;
        if (opts.tab) extras.tab = opts.tab;
        pushTo(reset([], extras));
      },
      toProfile: handle => {
        pushTo(reset([], { profile: handle }));
      },
      toSession: sessionId => {
        // Session id lives in the pathname, not the querystring —
        // full navigation so App remounts and SessionView reads the
        // pathname cleanly. No intent state to mirror; sessions are
        // server-authoritative.
        window.location.href = `/s/${encodeURIComponent(sessionId)}`;
      },
    };
  }, [isSignedIn, intent, handleStartTrade]);

  // Re-render every minute so the footer's "X ago" labels (prices,
  // build age) advance even while the user is idle. Cheap — one
  // setState per minute at the root is imperceptible.
  const [, setMinuteTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setMinuteTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Card indexes + flat array come from CardIndexContext — derived
  // once from the shared PriceData cache rather than recomputed per view.
  const { allLoadedCards } = cardIndex;
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
          .map(tc => tradeCardKey(tc.card) === key ? { ...tc, qty: Math.min(99, tc.qty + delta) } : tc)
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

  // Each branch below returns the view body only — the global
  // `<ListsDrawer>` (which every view can open via its header or the
  // AccountMenu) renders once below the view switch so navigating
  // between views doesn't remount its internal state (active tab,
  // picker mode, editing-item id).
  const renderBody = (): React.ReactNode => {
  // Home view — signed-in landing. Shows pending trades that need a
  // response, the user's enrolled communities, and a primary CTA into
  // the trade builder. Signed-out users never see it — detectViewMode
  // falls back to 'trade' when no user is present.
  if (viewMode === 'home') {
    // HomeView pulls its navigation from `useNavigation()`; no more
    // per-callback prop drilling. A single `nav` object enforces URL
    // + intent + viewMode lockstep so the intent-drift bug class is
    // closed at the construction site.
    return <HomeView auth={auth} />;
  }

  // Settings view — /?settings=1 for account + per-guild preferences.
  // Signed-out users can't reach it (menu item doesn't render), but if
  // someone hand-types the URL we still route here; the hooks will
  // 401 and show an error, which is acceptable.
  if (viewMode === 'settings') {
    // Close returns to the signed-in landing page. `nav.toHome()`
    // clears intent too, which matches the "you're done with settings,
    // drop back to the dashboard with no composer state lingering"
    // mental model.
    return <SettingsView onClose={nav.toHome} />;
  }

  if (viewMode === 'community') {
    // AppHeader's breadcrumb (Home ›) handles the return-to-root path;
    // no onClose prop needed — the link is a full navigation to `/`.
    return (
      <CommunityView
        wants={wants}
        available={available}
      />
    );
  }

  if (viewMode === 'trades-history') {
    // AppHeader's breadcrumb ("Home ›") handles return-to-root; the
    // view owns its navigation via the header links.
    return <TradesHistoryView />;
  }

  if (viewMode === 'trade-detail') {
    const tradeId = new URLSearchParams(window.location.search).get('trade') ?? '';
    // AppHeader's breadcrumb ("Home › My trades › @counterpart") owns
    // the return path — deep-linked users get "/?trades=1", in-SPA
    // users get the native back via the header's Home link.
    return <TradeDetailView tradeId={tradeId} />;
  }

  if (viewMode === 'session') {
    // `/s/<code>` — shared-state trade canvas. The code is the
    // session short-id. SessionView handles loading + terminal-state
    // rendering; bad codes get the in-view "not found" message
    // rather than a bare 404 route.
    const match = window.location.pathname.match(/^\/s\/([^/]+)/);
    const sessionId = match ? decodeURIComponent(match[1]) : '';
    return <SessionView sessionId={sessionId} />;
  }

  // Profile view — /u/<handle> shows a user's public lists.
  if (viewMode === 'profile') {
    const profileHandle = readProfileHandle();
    return (
      <ProfileView
        handle={profileHandle}
        percentage={percentage}
        priceMode={priceMode}
        onStartTrade={handleStartTrade}
      />
    );
  }

  // Shared-list landing — stand-alone view with its own chrome and
  // the "Start a trade" CTA that flips into trade mode.
  if (viewMode === 'list' && sharedLists) {
    return (
      <ListView
        sharedLists={sharedLists}
        senderHandle={senderHandle}
        percentage={percentage}
        priceMode={priceMode}
        onStartTrade={handleStartTrade}
      />
    );
  }

  return renderTradeBuilder();
  };

  function renderTradeBuilder() {
    return (
      <>
    <div className="h-[100dvh] bg-space-900 text-gray-100 flex flex-col overflow-hidden">
      {/* Trade builder is the "root" view — no breadcrumbs, logo alone
          orients. AppHeader supplies consistent NavMenu + AccountMenu. */}
      <AppHeader auth={auth} onOpenLists={openLists} />

      {/* View-level action strip — trade-builder CTAs (split/tabbed
          toggle, Share, Clear) live here rather than in AppHeader so
          they don't compete with breadcrumbs / NavMenu for width.
          Right-aligned, tight, drops Share/Clear on mobile into a kebab.
          "Invite someone" is always visible (even with no cards) since
          its value is "start a shared canvas with someone now"; the
          other actions depend on cards existing. */}
      <div className="px-3 sm:px-6 pt-2 pb-1 max-w-5xl mx-auto w-full shrink-0 flex items-center gap-2 justify-end">
        <TradeViewToggle mode={tradeViewMode} onToggle={toggleTradeView} />
        <ShareLiveTradeButton yourCards={yourCards} theirCards={theirCards} />
        {hasCards && (
          <>
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

      {/* Auto-balance prompt: only surfaces when a signed-in recipient
          arrives via ?from=<handle> on an empty trade. Replaces the
          always-visible matchmaker input — "enter a random handle" is
          a thin use case that belongs to Phase 4 (guild-scoped
          discovery), not permanent chrome here. */}
      {editId ? (
        <EditBar
          editingTradeId={editId}
          yourCards={yourCards}
          theirCards={theirCards}
          onApplyMatch={(yours, theirs) => {
            setYourCards(yours);
            setTheirCards(theirs);
          }}
        />
      ) : counterId ? (
        <CounterBar
          originalTradeId={counterId}
          yourCards={yourCards}
          theirCards={theirCards}
          onApplyMatch={(yours, theirs) => {
            setYourCards(yours);
            setTheirCards(theirs);
          }}
        />
      ) : proposeHandle ? (
        <ProposeBar
          recipientHandle={proposeHandle}
          wants={wants}
          available={available}
          yourCards={yourCards}
          theirCards={theirCards}
          recipientProfile={recipientProfile}
          recipientFetchState={recipientFetchState}
          onApplyMatch={(yours, theirs) => {
            setYourCards(yours);
            setTheirCards(theirs);
          }}
        />
      ) : (
        <AutoBalanceBanner
          senderHandle={senderHandle}
          autoBalanceRequested={intent.autoBalance}
          isSignedIn={!!user}
          hasCards={hasCards}
          allCards={allLoadedCards}
          wants={wants}
          available={available}
          onApplyMatch={(yours, theirs) => {
            setYourCards(yours);
            setTheirCards(theirs);
          }}
          onAutoBalanceConsumed={() => intent.setIntent({ autoBalance: false })}
        />
      )}

      {/* Trade panels. Two layouts:
           - split: both panels visible side-by-side (desktop default)
             with mobile flex-col + collapsible panels + drag divider
           - tabbed: single-focus tab bar + one panel at full width
          The toggle flips between them and persists per-device. */}
      <div className={`flex-1 min-h-0 px-3 pb-2 max-w-5xl mx-auto w-full flex flex-col ${tradeViewMode === 'tabbed' ? 'gap-0' : 'gap-2'}`}>
        {tradeViewMode === 'tabbed' && (
          <TradeTabBar
            active={activeTradeTab}
            onSelect={setActiveTradeTab}
            yourCards={yourCards}
            theirCards={theirCards}
            percentage={percentage}
            priceMode={priceMode}
          />
        )}
        {tradeViewMode === 'split' ? (
          <div ref={panelsRef} className="flex-1 min-h-0 flex flex-col md:grid md:grid-cols-2 gap-3">
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
              filters={filters}
              wants={wants}
              available={available}
              sharedLists={effectiveSharedLists}
              collapsed={isMobile && offeringCollapsed}
              onToggleCollapse={isMobile ? () => setOfferingCollapsed(c => !c) : undefined}
              flexBasis={!isMobile || offeringCollapsed || receivingCollapsed ? undefined : (splitRatio ?? undefined)}
              autoOpenSharedLink={autoOpenOfferingFromShared}
              onConsumeAutoOpen={consumeAutoOpenOffering}
              communityWantFamilyIds={community.wantFamilyIds}
              communityAvailableProductIds={community.availableProductIds}
              autoScopeToTheirs={!!proposeHandle}
              counterpartHandle={proposeHandle ?? senderHandle ?? null}
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
              filters={filters}
              wants={wants}
              available={available}
              sharedLists={effectiveSharedLists}
              collapsed={isMobile && receivingCollapsed}
              onToggleCollapse={isMobile ? () => setReceivingCollapsed(c => !c) : undefined}
              flexBasis={!isMobile || offeringCollapsed || receivingCollapsed || splitRatio === null ? undefined : 1 - splitRatio}
              communityWantFamilyIds={community.wantFamilyIds}
              communityAvailableProductIds={community.availableProductIds}
              autoScopeToTheirs={!!proposeHandle}
              counterpartHandle={proposeHandle ?? senderHandle ?? null}
            />
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            {activeTradeTab === 'offering' ? (
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
                filters={filters}
                wants={wants}
                available={available}
                sharedLists={effectiveSharedLists}
                collapsed={false}
                headerless
                autoOpenSharedLink={autoOpenOfferingFromShared}
                onConsumeAutoOpen={consumeAutoOpenOffering}
                communityWantFamilyIds={community.wantFamilyIds}
                communityAvailableProductIds={community.availableProductIds}
                autoScopeToTheirs={!!proposeHandle}
                counterpartHandle={proposeHandle ?? senderHandle ?? null}
              />
            ) : (
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
                filters={filters}
                wants={wants}
                available={available}
                sharedLists={effectiveSharedLists}
                collapsed={false}
                headerless
                communityWantFamilyIds={community.wantFamilyIds}
                communityAvailableProductIds={community.availableProductIds}
                autoScopeToTheirs={!!proposeHandle}
                counterpartHandle={proposeHandle ?? senderHandle ?? null}
              />
            )}
          </div>
        )}
      </div>

      {/* Balance bar at bottom — TradeBalance owns its own click
          handling now: a tap when collapsed expands first, a tap when
          expanded opens the summary. */}
      <div className="shrink-0 px-3 pb-3 pt-2 max-w-5xl mx-auto w-full">
        <TradeBalance
          yourCards={yourCards}
          theirCards={theirCards}
          collapsed={isMobile && bannerCollapsed}
          onToggleCollapse={isMobile ? () => setBannerCollapsed(c => !c) : undefined}
          onPrimary={hasCards ? () => setShowSummary(true) : undefined}
        />
      </div>

      {/* Migration prompt on first sign-in with local items */}
      {migrationPrompt && <MigrationDialog prompt={migrationPrompt} />}

      {/* Trade summary overlay */}
      {showSummary && (
        <TradeSummary
          yourCards={yourCards}
          theirCards={theirCards}
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
            {isBetaChannel() && (
              <span className="text-gold/40"> · built {timeAgo(APP_BUILD_TIME)}</span>
            )}
          </span>
          {user && syncStatus !== 'idle' && (
            <>
              <span className="text-space-600" aria-hidden>·</span>
              <span className={
                syncStatus === 'syncing' ? 'text-gold/70 animate-pulse' :
                syncStatus === 'error' ? 'text-red-400' :
                syncStatus === 'offline' ? 'text-gray-600' : 'text-gray-500'
              }>
                {syncStatus === 'syncing' ? 'Syncing…' :
                 syncStatus === 'error' ? 'Sync error' :
                 syncStatus === 'offline' ? 'Offline' : ''}
              </span>
            </>
          )}
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

  // Shared app chrome. `<ListsDrawer>` renders once at the root so
  // navigating between views doesn't remount its internal state
  // (active tab, editing-item id, picker mode). Opened from any
  // view's header via `openLists()` on DrawerContext.
  return (
    <>
      <ListsDrawer
        wants={wants}
        available={available}
        allCards={allLoadedCards}
        percentage={percentage}
        priceMode={priceMode}
        open={listsDrawerOpen}
        onOpenChange={setListsDrawerOpen}
      />
      <NavigationProvider value={nav}>
        {renderBody()}
      </NavigationProvider>
    </>
  );
}

/**
 * Small header button that flips the trade layout between split and
 * tabbed. Icon swaps to visually echo the CURRENT mode — square
 * (split) vs stacked-lines (tabbed). Title attribute clarifies what
 * clicking will do.
 */
function TradeViewToggle({ mode, onToggle }: { mode: 'split' | 'tabbed'; onToggle: () => void }) {
  const title = mode === 'split' ? 'Switch to tabbed view' : 'Switch to split view';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={title}
      title={title}
      className="flex items-center justify-center w-8 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-gray-400 hover:text-gold transition-colors"
    >
      {mode === 'split' ? (
        // Two side-by-side rectangles
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
          <rect x="3" y="5" width="7" height="14" rx="1.5" />
          <rect x="14" y="5" width="7" height="14" rx="1.5" />
        </svg>
      ) : (
        // Tab-like icon — single large panel with tab headers above
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
          <rect x="3" y="8" width="18" height="12" rx="1.5" />
          <line x1="5" y1="4" x2="10" y2="4" strokeLinecap="round" />
          <line x1="14" y1="4" x2="19" y2="4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

/**
 * Tab bar that sits above a single-panel trade layout when the view
 * mode is `tabbed`. Each tab shows the side's color accent, running
 * card count, and running $ total — so the user can see the
 * currently-hidden side's state at a glance and decide whether to
 * switch to it.
 */
function TradeTabBar({
  active,
  onSelect,
  yourCards,
  theirCards,
  percentage,
  priceMode,
}: {
  active: 'offering' | 'receiving';
  onSelect: (tab: 'offering' | 'receiving') => void;
  yourCards: TradeCard[];
  theirCards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;
}) {
  const offerCount = yourCards.reduce((s, c) => s + c.qty, 0);
  const receiveCount = theirCards.reduce((s, c) => s + c.qty, 0);
  const tradeCardTotal = (cards: TradeCard[]) => cards.reduce((sum, tc) => {
    const adj = (getTradeCardPrice(tc, priceMode, percentage));
    return sum + adj * tc.qty;
  }, 0);
  const offerTotal = tradeCardTotal(yourCards);
  const receiveTotal = tradeCardTotal(theirCards);

  return (
    <div role="tablist" aria-label="Trade side" className="flex gap-1 shrink-0">
      <TradeTab
        side="offering"
        active={active === 'offering'}
        count={offerCount}
        total={offerTotal}
        onSelect={() => onSelect('offering')}
      />
      <TradeTab
        side="receiving"
        active={active === 'receiving'}
        count={receiveCount}
        total={receiveTotal}
        onSelect={() => onSelect('receiving')}
      />
    </div>
  );
}

function TradeTab({
  side,
  active,
  count,
  total,
  onSelect,
}: {
  side: 'offering' | 'receiving';
  active: boolean;
  count: number;
  total: number;
  onSelect: () => void;
}) {
  const activeCls = side === 'offering'
    ? 'bg-emerald-500/15 border-emerald-400/50 text-emerald-200'
    : 'bg-blue-500/15 border-blue-400/50 text-blue-200';
  const inactiveCls = 'bg-space-800/40 border-space-700 text-gray-400 hover:border-gray-500';
  const label = side === 'offering' ? 'Offering' : 'Receiving';

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={`flex-1 flex items-baseline justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold uppercase tracking-wider transition-colors ${active ? activeCls : inactiveCls}`}
    >
      <span>{label}</span>
      {count > 0 && (
        <span className="text-[10px] tabular-nums opacity-80">
          {count} · ${total.toFixed(2)}
        </span>
      )}
    </button>
  );
}

function getTradeCardPrice(tc: TradeCard, priceMode: PriceMode, percentage: number): number {
  return adjustPrice(getCardPrice(tc.card, priceMode), percentage) ?? 0;
}

export default App;
