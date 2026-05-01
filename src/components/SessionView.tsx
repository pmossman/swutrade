import { useCallback, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AppHeader, type BreadcrumbSegment } from './ui/AppHeader';
import { LoadingState, ErrorState } from './ui/states';
import { TradeSide } from './TradeSide';
import { TradeBalance } from './TradeBalance';
import { ListsDrawer } from './ListsDrawer';
import { useAuthContext } from '../contexts/AuthContext';
import { useCardIndexContext } from '../contexts/CardIndexContext';
import { usePriceDataContext } from '../contexts/PriceDataContext';
import { useDrawerContext } from '../contexts/DrawerContext';
import { usePricing } from '../contexts/PricingContext';
import { useSelectionFilters } from '../hooks/useSelectionFilters';
import { useWants } from '../hooks/useWants';
import { useAvailable } from '../hooks/useAvailable';
import { useSession, type SessionView as SessionData, type SessionPreview } from '../hooks/useSession';
import { SessionTimelinePanel } from './SessionTimelinePanel';
import { InlineSuggestionList, RevertSuggestionBanner } from './SessionSuggestions';
import { SessionSuggestComposer } from './SessionSuggestComposer';
import { useIsMobile } from '../hooks/useMediaQuery';
import { PERSIST_KEYS } from '../persistence';
import { tradeCardKey, type TradeCard, type CardVariant } from '../types';
import type { CardSnapshot } from '../hooks/useTradeDetail';
type TradeCardSnapshot = CardSnapshot;
import { extractVariantLabel } from '../variants';
import { hapticMedium, hapticSoft, hapticSuccess } from '../utils/haptics';

/**
 * Shared-state trade canvas — the interactive surface for a session
 * between two signed-in users. Mounts at `/s/<id>`.
 *
 * Layout is explicit about the flow: add cards first, confirm after.
 *   - Top: identity strip (who's on the other side + lifecycle status).
 *   - Middle: balance strip + two panels. Left is the viewer's
 *     editable half (powered by TradeSide + `useSession.saveCards`).
 *     Right is the counterpart's cards — same TradeSide component in
 *     `readOnly` mode so they get the full per-card price breakdown
 *     the viewer's side has.
 *   - Bottom: action bar with Confirm + Cancel. Placed AFTER the cards
 *     because the flow is "stage → confirm" — confirming a trade
 *     before either side has finished adding makes no sense.
 *   - Settled / cancelled / expired states visibly lock the canvas:
 *     a prominent banner names the terminal state, TradeSide flips to
 *     readOnly on both sides, and the action bar hides entirely.
 *   - A banner fires when the counterpart has edited since the
 *     viewer last saw it (dismissed by scrolling or clicking through).
 */
export function SessionView({ sessionId }: { sessionId: string }) {
  const auth = useAuthContext();
  const viewerIsGhost = !!auth.user?.isAnonymous;
  const priceData = usePriceDataContext();
  const cardIndex = useCardIndexContext();
  const { listsDrawerOpen, setListsDrawerOpen } = useDrawerContext();
  const { percentage, priceMode } = usePricing();
  const wants = useWants();
  const available = useAvailable();
  // Fresh filter state per session — doesn't share with the main
  // trade builder so session-specific variant/set scope doesn't
  // bleed back into the user's calculator when they navigate home.
  const filters = useSelectionFilters({
    variants: PERSIST_KEYS.tradeSelVariants,
    sets: PERSIST_KEYS.tradeSelSets,
  });

  const api = useSession(sessionId);
  const {
    session, preview, status,
    saveCards, confirm, unconfirm, cancel, claim,
    hasUnseenCounterpartEdit, markCounterpartSeen,
    sendChat, suggest, acceptSuggestion, dismissSuggestion, proposeRevert,
  } = api;
  const [claiming, setClaiming] = useState(false);
  const [unconfirming, setUnconfirming] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [suggestComposerOpen, setSuggestComposerOpen] = useState(false);
  // Pre-filled cardsToRemove for the composer — set by the per-card
  // "Suggest swap" kebab so the composer opens with the card already
  // staged for removal, leaving the user to pick the replacement.
  // Reset on close.
  const [suggestComposerInitialRemove, setSuggestComposerInitialRemove] = useState<TradeCardSnapshot[]>([]);
  // Mobile split-view: same pattern as the trade builder. Each side
  // can be tap-collapsed; on desktop the panels render side-by-side
  // and these flags are ignored. Single-column collapse cap: at most
  // one side may be collapsed at a time so the canvas never
  // disappears entirely.
  const isMobile = useIsMobile();
  const [yourSideCollapsed, setYourSideCollapsed] = useState(false);
  const [theirSideCollapsed, setTheirSideCollapsed] = useState(false);

  // Counterpart side from the viewer's POV. The server tells us
  // viewer.side ('a' | 'b'); the counterpart is the other.
  const counterpartSide: 'a' | 'b' = session?.viewer.side === 'a' ? 'b' : 'a';

  // Suggestion routing — partition session.suggestions by where they
  // would land so each gets rendered next to its target:
  //   - incoming: target side === viewer's side. Rendered inline at
  //     the top of YOUR-side panel (where cards would land).
  //   - outgoing: viewer authored, target = counterpart. Rendered
  //     inline at the top of COUNTERPART-side panel (where cards
  //     would land).
  //   - reverts: targetSide === 'both'. Rendered as a global banner
  //     above the canvas — they don't belong to one side.
  const allSuggestions = session?.suggestions ?? [];
  const incomingSuggestions = allSuggestions.filter(s =>
    (s.targetSide === 'a' || s.targetSide === 'b') && s.targetIsViewer);
  const outgoingSuggestions = allSuggestions.filter(s =>
    (s.targetSide === 'a' || s.targetSide === 'b') && s.suggestedByViewer);
  const revertSuggestions = allSuggestions.filter(s => s.targetSide === 'both');

  // Cards already referenced by a pending non-revert suggestion. The
  // server enforces the same rule (returns 'card-locked'); this is
  // the UI guard so the affordance simply isn't there for locked
  // cards — better than letting the user click a kebab item that
  // would error.
  const lockedProductIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of allSuggestions) {
      if (s.targetSide === 'both') continue;
      for (const c of s.cardsToAdd) set.add(c.productId);
      for (const c of s.cardsToRemove) set.add(c.productId);
    }
    return set;
  }, [allSuggestions]);

  const breadcrumbs: BreadcrumbSegment[] = useMemo(() => [
    { label: 'Home', href: '/' },
    { label: 'My trades', href: '/?trades=1' },
    { label: session?.counterpart ? `Trade with @${session.counterpart.handle}` : 'Shared trade' },
  ], [session]);

  const { byProductId } = cardIndex;

  // Snapshots → TradeCard[] for TradeSide rendering. We rehydrate
  // against the live CardIndex; if a productId isn't found (stale
  // snapshot, unreleased card) we fall back to a thin stub so the
  // row still renders with the stored name.
  const viewerTradeCards: TradeCard[] = useMemo(() => {
    if (!session) return [];
    return session.yourCards.map(snap => ({
      card: byProductId.get(snap.productId) ?? stubCard(snap),
      qty: snap.qty,
    }));
  }, [session, byProductId]);

  // Edits: TradeSide's onAdd/onRemove/onChangeQty operate on
  // TradeCard[]; we translate back to snapshots and POST. A ref
  // tracks the in-progress snapshot list so rapid successive edits
  // build on the latest state rather than fighting each other.
  const viewerSnapshotsRef = useRef<TradeCardSnapshot[]>([]);
  useMemo(() => {
    viewerSnapshotsRef.current = session?.yourCards ?? [];
  }, [session?.yourCards]);

  // TradeSide hands edits back keyed by tradeCardKey(card) =
  // `${productId||name}-${set}`. Set slugs are hyphenated
  // ("jump-to-lightspeed") so a naive split-on-'-' yields the wrong
  // productId; we map keys → productId via the rendered card list.
  const keyToProductId = useMemo(() => {
    const map = new Map<string, string>();
    for (const tc of viewerTradeCards) {
      map.set(tradeCardKey(tc.card), tc.card.productId || tc.card.name);
    }
    return map;
  }, [viewerTradeCards]);

  const writeCards = useCallback((next: TradeCardSnapshot[]) => {
    viewerSnapshotsRef.current = next;
    void saveCards(next);
  }, [saveCards]);

  const handleAdd = useCallback((card: CardVariant) => {
    const current = viewerSnapshotsRef.current;
    const key = card.productId || card.name;
    const existingIdx = current.findIndex(s => s.productId === key);
    let next: TradeCardSnapshot[];
    if (existingIdx >= 0) {
      next = current.map((s, i) => i === existingIdx ? { ...s, qty: s.qty + 1 } : s);
    } else {
      next = [...current, snapshotFromCardVariant(card, 1)];
    }
    writeCards(next);
  }, [writeCards]);

  const handleRemove = useCallback((key: string) => {
    const productId = keyToProductId.get(key);
    if (!productId) return;
    const next = viewerSnapshotsRef.current.filter(s => s.productId !== productId);
    writeCards(next);
  }, [keyToProductId, writeCards]);

  const handleChangeQty = useCallback((key: string, delta: number) => {
    const productId = keyToProductId.get(key);
    if (!productId) return;
    const next = viewerSnapshotsRef.current
      .map(s => s.productId === productId ? { ...s, qty: s.qty + delta } : s)
      .filter(s => s.qty > 0);
    writeCards(next);
  }, [keyToProductId, writeCards]);

  const handleLoadAllSets = useCallback(() => {
    priceData.loadAllSets();
  }, [priceData]);

  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const handleConfirm = useCallback(async () => {
    if (confirming || !session || session.status !== 'active') return;
    hapticMedium(); // "I'm committing" feedback on the tap itself.
    setConfirming(true);
    try {
      const result = await confirm();
      // Double-pulse when both sides have now confirmed and the trade
      // settles — this is the "it happened" moment worth celebrating
      // via feel, not just a banner flip.
      if (result?.settled) hapticSuccess();
    } finally {
      setConfirming(false);
    }
  }, [confirm, confirming, session]);
  const handleCancel = useCallback(async () => {
    if (cancelling || !session || session.status !== 'active') return;
    if (!window.confirm('Cancel this shared trade? Both sides will lose the in-progress state.')) return;
    hapticMedium();
    setCancelling(true);
    try {
      await cancel();
    } finally {
      setCancelling(false);
    }
  }, [cancel, cancelling, session]);
  const handleUnconfirm = useCallback(async () => {
    if (unconfirming || !session || session.status !== 'active') return;
    hapticSoft();
    setUnconfirming(true);
    try {
      await unconfirm();
    } finally {
      setUnconfirming(false);
    }
  }, [unconfirm, unconfirming, session]);

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <AppHeader auth={auth} breadcrumbs={breadcrumbs} />

      <main className="flex-1 px-3 sm:px-6 py-3 max-w-6xl mx-auto w-full flex flex-col gap-3">
        {status === 'loading' && !session && !preview && <LoadingState label="Loading shared trade…" />}
        {status === 'error' && !session && (
          <ErrorState>Couldn't load this trade. Try refreshing.</ErrorState>
        )}
        {status === 'not-found' && (
          <ErrorState>
            This shared trade doesn't exist or is no longer available. It may have been cancelled, expired, or already claimed by someone else.
          </ErrorState>
        )}

        {status === 'preview' && preview && (
          <InvitePrompt
            preview={preview}
            claiming={claiming}
            onClaim={async () => {
              setClaiming(true);
              try {
                await claim();
              } finally {
                setClaiming(false);
              }
            }}
          />
        )}

        {session && session.openSlot && (
          <OpenSlotInvite
            sessionId={session.id}
            viewerIsGhost={viewerIsGhost}
            onCancel={async () => { await cancel(); }}
          />
        )}

        {session && !session.openSlot && viewerIsGhost && (
          <GhostSignInBanner
            onSignIn={() => {
              // Full nav to the Discord OAuth start endpoint. The
              // callback will merge this ghost's sessions into the
              // real user row before redirecting to `/`. After sign-
              // in the user can navigate back to this session URL
              // and see it under their real identity.
              window.location.href = '/api/auth/discord';
            }}
          />
        )}

        {session && !session.openSlot && (() => {
          const counterpartHandle = session.counterpart?.handle ?? null;
          const terminal = session.status !== 'active';
          const counterpartCards = snapshotsToTradeCards(session.theirCards, byProductId);
          return (
            <>
              <SessionIdentityStrip
                session={session}
                onOpenTimeline={() => setTimelineOpen(true)}
              />

              {terminal ? (
                <TerminalBanner
                  session={session}
                  isSignedIn={!!auth.user && !auth.user.isAnonymous}
                />
              ) : hasUnseenCounterpartEdit ? (
                <button
                  type="button"
                  onClick={markCounterpartSeen}
                  className="w-full text-left px-3 py-2 rounded-lg border border-cyan-500/40 bg-cyan-950/30 text-[12px] text-cyan-200 hover:bg-cyan-950/50 transition-colors"
                >
                  @{counterpartHandle ?? 'Your counterpart'} made changes. Tap to dismiss.
                </button>
              ) : null}

              {/* Active-session commitment strip — surfaces who has
                  confirmed and what's needed next. Only one of the two
                  partial states renders (viewer-only or counterpart-
                  only) since "both confirmed" is a terminal settled
                  state handled by the banner above. */}
              {!terminal && (session.confirmedByViewer || session.confirmedByCounterpart) && (
                <CommitmentStrip
                  viewerConfirmed={session.confirmedByViewer}
                  counterpartHandle={counterpartHandle}
                />
              )}

              {!terminal && revertSuggestions.length > 0 && (
                <RevertSuggestionBanner
                  suggestions={revertSuggestions}
                  counterpartHandle={counterpartHandle}
                  onAccept={acceptSuggestion}
                  onDismiss={dismissSuggestion}
                />
              )}

              <TradeBalance
                yourCards={viewerTradeCards}
                theirCards={counterpartCards}
              />

              {/* Mobile-only segmented toggle. The per-panel chevron
                  in the header was hard to discover — this surfaces
                  the same state as a discrete control so the user
                  doesn't have to know to tap a panel header to
                  collapse it. Three modes: Both / Yours / Theirs.
                  Hidden on desktop where the side-by-side grid
                  already shows everything. */}
              {isMobile && !terminal && (
                <SplitViewToggle
                  yourCollapsed={yourSideCollapsed}
                  theirCollapsed={theirSideCollapsed}
                  counterpartHandle={counterpartHandle}
                  onSelectBoth={() => { setYourSideCollapsed(false); setTheirSideCollapsed(false); }}
                  onSelectYours={() => { setYourSideCollapsed(false); setTheirSideCollapsed(true); }}
                  onSelectTheirs={() => { setYourSideCollapsed(true); setTheirSideCollapsed(false); }}
                />
              )}

              <div className="flex-1 min-h-0 flex flex-col md:grid md:grid-cols-2 gap-3">
                <TradeSide
                  label="Your side"
                  cards={viewerTradeCards}
                  percentage={percentage}
                  priceMode={priceMode}
                  onAdd={handleAdd}
                  onRemove={handleRemove}
                  onChangeQty={handleChangeQty}
                  accentColor="emerald"
                  setCards={priceData.cards}
                  isLoading={priceData.isAnyLoading}
                  onLoadAllSets={handleLoadAllSets}
                  filters={filters}
                  wants={wants}
                  available={available}
                  sharedLists={null}
                  // Mobile-only collapse: tap header to fold the
                  // panel; lets the user focus on one side at a time.
                  // Locked-open if the OTHER side is currently
                  // collapsed (prevents both-collapsed empty canvas).
                  collapsed={isMobile && yourSideCollapsed}
                  onToggleCollapse={isMobile && !theirSideCollapsed
                    ? () => setYourSideCollapsed(c => !c)
                    : undefined}
                  counterpartHandle={counterpartHandle}
                  // Once the viewer has confirmed, their side locks.
                  // Any edit auto-clears confirmations server-side
                  // (editSessionSide), which would silently invalidate
                  // the user's explicit commitment — better to force
                  // them through Unconfirm so the uncommit is a deliberate
                  // act, not a surprise side-effect of a typo fix.
                  readOnly={terminal || session.confirmedByViewer}
                  readOnlyEmptyLabel={
                    session.confirmedByViewer && !terminal
                      ? 'Unconfirm above to keep editing this side.'
                      : undefined
                  }
                  // Incoming cross-side suggestions land HERE since
                  // the cards would land on this side if accepted.
                  aboveCardList={!terminal && incomingSuggestions.length > 0 ? (
                    <InlineSuggestionList
                      suggestions={incomingSuggestions}
                      counterpartHandle={counterpartHandle}
                      onAccept={acceptSuggestion}
                      onDismiss={dismissSuggestion}
                    />
                  ) : undefined}
                />
                <TradeSide
                  label={counterpartHandle ? `@${counterpartHandle}'s side` : 'Their side'}
                  cards={counterpartCards}
                  percentage={percentage}
                  priceMode={priceMode}
                  // Read-only — counterpart owns this half. Handlers are
                  // required by the interface but never fire because
                  // Add Card + qty steppers are hidden in readOnly mode.
                  onAdd={noop}
                  onRemove={noop}
                  onChangeQty={noop}
                  accentColor="blue"
                  setCards={priceData.cards}
                  isLoading={priceData.isAnyLoading}
                  onLoadAllSets={handleLoadAllSets}
                  filters={filters}
                  wants={wants}
                  available={available}
                  sharedLists={null}
                  collapsed={isMobile && theirSideCollapsed}
                  onToggleCollapse={isMobile && !yourSideCollapsed
                    ? () => setTheirSideCollapsed(c => !c)
                    : undefined}
                  counterpartHandle={counterpartHandle}
                  readOnly
                  readOnlyEmptyLabel={
                    counterpartHandle
                      ? `Waiting for @${counterpartHandle} to add cards.`
                      : 'Waiting for your counterpart to add cards.'
                  }
                  // Outgoing suggestions render at the top of the
                  // counterpart's panel (where their cards would land
                  // on accept).
                  aboveCardList={!terminal && outgoingSuggestions.length > 0 ? (
                    <InlineSuggestionList
                      suggestions={outgoingSuggestions}
                      counterpartHandle={counterpartHandle}
                      onAccept={acceptSuggestion}
                      onDismiss={dismissSuggestion}
                    />
                  ) : undefined}
                  // Per-card actions on counterpart cards:
                  //   - "Suggest remove this card" fires a one-tap
                  //     suggestion with cardsToRemove: [thisCard].
                  //   - "Suggest swap" opens the composer pre-filled
                  //     with this card in cardsToRemove; the user
                  //     picks the replacement card(s) for cardsToAdd.
                  cardActions={!terminal ? (tc) => {
                    if (!tc.card.productId) return [];
                    const productId = tc.card.productId;
                    // Skip the suggest-* actions when this card is
                    // already referenced by a pending suggestion —
                    // prevents stacking conflicting suggestions on
                    // the same card. Show a disabled descriptive
                    // item instead of an empty kebab so the user
                    // understands *why* the options are missing.
                    if (lockedProductIds.has(productId)) {
                      return [{ label: 'In a pending suggestion', disabled: true }];
                    }
                    const snapshot: TradeCardSnapshot = {
                      productId,
                      name: tc.card.name,
                      variant: extractVariantLabel(tc.card.name),
                      qty: tc.qty,
                      unitPrice: tc.card.marketPrice ?? null,
                    };
                    return [
                      {
                        label: 'Suggest remove this card',
                        onClick: () => {
                          void suggest({
                            targetSide: counterpartSide,
                            cardsToRemove: [snapshot],
                          });
                        },
                        icon: (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                          </svg>
                        ),
                      },
                      {
                        label: 'Suggest swap…',
                        onClick: () => {
                          setSuggestComposerInitialRemove([snapshot]);
                          setSuggestComposerOpen(true);
                        },
                        icon: (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 3l4 4m0 0l-4 4m4-4H4m4 14l-4-4m0 0l4-4m-4 4h16" />
                          </svg>
                        ),
                      },
                    ];
                  } : undefined}
                  // Footer in the counterpart-panel slot becomes a
                  // "+ Suggest a card" button — same spatial slot
                  // an Add Card would normally occupy on an editable
                  // side, so the affordance is where the user expects.
                  customFooter={!terminal ? (
                    <button
                      type="button"
                      onClick={() => setSuggestComposerOpen(true)}
                      className="w-full flex items-center justify-center gap-1.5 py-1.5 border-t border-space-600 bg-amber-950/20 hover:bg-amber-900/30 text-amber-200 text-xs font-bold tracking-wide uppercase transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                      </svg>
                      Suggest a card
                    </button>
                  ) : undefined}
                />
              </div>

              {!terminal && (
                <SessionActionBar
                  session={session}
                  onConfirm={handleConfirm}
                  onUnconfirm={handleUnconfirm}
                  onCancel={handleCancel}
                  confirming={confirming}
                  unconfirming={unconfirming}
                  cancelling={cancelling}
                />
              )}
            </>
          );
        })()}
      </main>

      <ListsDrawer
        wants={wants}
        available={available}
        allCards={cardIndex.allLoadedCards}
        percentage={percentage}
        priceMode={priceMode}
        open={listsDrawerOpen}
        onOpenChange={setListsDrawerOpen}
      />

      {timelineOpen && session && (
        <SessionTimelinePanel
          session={session}
          onClose={() => setTimelineOpen(false)}
          sendChat={sendChat}
          proposeRevert={proposeRevert}
        />
      )}

      {suggestComposerOpen && session && (
        <SessionSuggestComposer
          counterpartSide={counterpartSide}
          counterpartHandle={session.counterpart?.handle ?? null}
          allCards={cardIndex.allLoadedCards}
          initialCardsToRemove={suggestComposerInitialRemove}
          lockedProductIds={lockedProductIds}
          onClose={() => {
            setSuggestComposerOpen(false);
            setSuggestComposerInitialRemove([]);
          }}
          onSubmit={suggest}
        />
      )}
    </div>
  );
}

// --- Mobile split-view toggle --------------------------------------------

/**
 * Three-state segmented control surfacing the side-collapse state on
 * mobile. The trade builder's tap-the-header-to-collapse pattern is
 * subtle (chevron icon at panel-header-left); session users were
 * missing it during dogfooding. This exposes the same state as a
 * discrete control with explicit labels so the affordance is obvious.
 */
function SplitViewToggle({
  yourCollapsed,
  theirCollapsed,
  counterpartHandle,
  onSelectBoth,
  onSelectYours,
  onSelectTheirs,
}: {
  yourCollapsed: boolean;
  theirCollapsed: boolean;
  counterpartHandle: string | null;
  onSelectBoth: () => void;
  onSelectYours: () => void;
  onSelectTheirs: () => void;
}) {
  // Currently active mode derived from the two collapse flags.
  const mode: 'both' | 'yours' | 'theirs' =
    yourCollapsed ? 'theirs'
    : theirCollapsed ? 'yours'
    : 'both';

  const buttonClass = (active: boolean) =>
    `flex-1 px-3 py-1.5 text-[11px] font-bold tracking-wide uppercase transition-colors ${
      active
        ? 'bg-gold/20 text-gold-bright'
        : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
    }`;

  return (
    <div
      role="group"
      aria-label="Trade view mode"
      className="flex items-stretch rounded-md border border-space-700 bg-space-800/40 overflow-hidden"
    >
      <button type="button" onClick={onSelectYours} className={buttonClass(mode === 'yours')} aria-pressed={mode === 'yours'}>
        Yours
      </button>
      <button type="button" onClick={onSelectBoth} className={buttonClass(mode === 'both')} aria-pressed={mode === 'both'}>
        Both
      </button>
      <button type="button" onClick={onSelectTheirs} className={buttonClass(mode === 'theirs')} aria-pressed={mode === 'theirs'}>
        @{counterpartHandle ?? 'Theirs'}
      </button>
    </div>
  );
}

// --- Identity + status strip (top) ---------------------------------------

/**
 * Top strip — identifies the counterpart and surfaces the lifecycle
 * state. Never carries the Confirm / Cancel buttons: those belong
 * below the cards so the flow reads as stage → confirm.
 */
function SessionIdentityStrip({
  session,
  onOpenTimeline,
}: {
  session: SessionData;
  onOpenTimeline: () => void;
}) {
  const counterpart = session.counterpart;
  const settled = session.status === 'settled';
  const cancelled = session.status === 'cancelled';
  const expired = session.status === 'expired';
  const active = session.status === 'active';

  const statusBadge = (() => {
    if (settled) return <Badge tone="emerald">Settled</Badge>;
    if (cancelled) return <Badge tone="neutral">Cancelled</Badge>;
    if (expired) return <Badge tone="neutral">Expired</Badge>;
    return <Badge tone="cyan">Shared · both editing</Badge>;
  })();

  return (
    <section className="rounded-xl border border-space-700 bg-space-800/40 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {counterpart && (
          <>
            <CounterpartAvatar
              avatarUrl={counterpart.avatarUrl}
              name={counterpart.username || counterpart.handle}
            />
            <div className="min-w-0">
              <div className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">
                Shared trade with
              </div>
              <div className="text-base font-semibold text-gray-100 truncate">
                @{counterpart.handle}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {statusBadge}
        {active && (
          <>
            <ConfirmBadge
              label="You"
              confirmed={session.confirmedByViewer}
            />
            <ConfirmBadge
              label={`@${counterpart?.handle ?? 'them'}`}
              confirmed={session.confirmedByCounterpart}
            />
          </>
        )}
        <TimelineToggle
          unreadCount={session.unreadCount}
          onClick={onOpenTimeline}
        />
      </div>
    </section>
  );
}

/**
 * "Activity" pill that opens the timeline panel. Surfaces the unread
 * badge so the counterpart's chat / edits don't go unseen — clears
 * via `markRead` (auto-fired on visibility) once the panel is open.
 */
function TimelineToggle({ unreadCount, onClick }: { unreadCount: number; onClick: () => void }) {
  const hasUnread = unreadCount > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={hasUnread ? `Chat & history (${unreadCount} unread)` : 'Chat & history'}
      className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-bold uppercase tracking-wide transition-colors ${
        hasUnread
          ? 'bg-gold/20 border-gold/60 text-gold-bright hover:bg-gold/30 animate-pulse-unread'
          : 'bg-space-800/60 border-space-700 text-gray-300 hover:text-gold hover:border-gold/40'
      }`}
    >
      {/* Chat-bubble icon — explicit visual cue that this surface
          carries chat, not just system events. The "Activity" label
          alone reads as read-only history; the bubble + the "Chat"
          word in the label clarify it's interactive. */}
      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
        <path
          d="M2.5 4.5C2.5 3.4 3.4 2.5 4.5 2.5h7c1.1 0 2 .9 2 2v5c0 1.1-.9 2-2 2H7l-3 2.5V11.5c-.83 0-1.5-.67-1.5-1.5z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>Chat</span>
      {hasUnread && (
        <span className="inline-flex items-center justify-center min-w-[1.1rem] px-1 h-4 rounded-full bg-gold-bright text-space-900 text-[10px] font-bold tabular-nums shadow-[0_0_8px_rgba(255,215,0,0.5)]">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
}

// --- Terminal banner (settled / cancelled / expired) ----------------------

/**
 * Prominent banner rendered in place of the counterpart-edit nudge
 * when the session has reached a terminal state. Reads as a "this
 * trade is locked" notice — pairs with `readOnly` TradeSide on both
 * sides of the canvas so there's no ambiguity about whether further
 * edits are possible.
 */
function TerminalBanner({
  session,
  isSignedIn,
}: {
  session: SessionData;
  isSignedIn: boolean;
}) {
  const counterpartHandle = session.counterpart?.handle ?? null;
  // Escape affordance — terminal sessions used to dead-end the user
  // on the canvas with no route out. Signed-in users get a "Back to
  // your trades" link; ghosts (no My Trades surface) get "Back to
  // home" which lands them on the ghost-home session list.
  const escape = (
    <a
      href={isSignedIn ? '/?trades=1' : '/'}
      className="inline-flex items-center gap-1 text-[12px] font-semibold text-gold hover:text-gold-bright transition-colors"
    >
      {isSignedIn ? 'Back to your trades' : 'Back to home'}
      <span aria-hidden>→</span>
    </a>
  );

  if (session.status === 'settled') {
    const when = session.settledAt ?? session.updatedAt;
    return (
      <section className="rounded-lg border border-emerald-500/40 bg-emerald-900/20 px-4 py-3 flex flex-col gap-2">
        <div className="text-[11px] tracking-[0.18em] uppercase text-emerald-300 font-bold">
          Trade settled
        </div>
        <div className="text-sm text-gray-200">
          Both of you confirmed on {formatTerminalDate(when)}. This trade is locked — no more edits.
        </div>
        {escape}
      </section>
    );
  }
  if (session.status === 'cancelled') {
    return (
      <section className="rounded-lg border border-space-600 bg-space-800/60 px-4 py-3 flex flex-col gap-2">
        <div className="text-[11px] tracking-[0.18em] uppercase text-gray-400 font-bold">
          Trade cancelled
        </div>
        <div className="text-sm text-gray-300">
          This trade was cancelled{counterpartHandle ? ` — either you or @${counterpartHandle} closed it out` : ''}. No more edits.
        </div>
        {escape}
      </section>
    );
  }
  // expired
  return (
    <section className="rounded-lg border border-space-600 bg-space-800/60 px-4 py-3 flex flex-col gap-2">
      <div className="text-[11px] tracking-[0.18em] uppercase text-gray-400 font-bold">
        Trade expired
      </div>
      <div className="text-sm text-gray-300">
        This trade expired from inactivity. No more edits — start a fresh one if you still want to trade.
      </div>
      {escape}
    </section>
  );
}

function formatTerminalDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// --- Action bar (below cards) --------------------------------------------

/**
 * Confirm + Unconfirm + Cancel live HERE, below the cards, because
 * the flow is stage → confirm. Only renders when the session is
 * active; terminal states drop the bar entirely.
 *
 * Primary action swaps based on viewer state:
 *   - Not confirmed: "Confirm trade" (emerald)
 *   - Already confirmed: "Unconfirm to edit" (gold outline) — clears
 *     the viewer's commitment so they can edit their side again.
 *     The existing editSessionSide auto-clears confirmations, but
 *     exposing Unconfirm explicitly keeps "I want to uncommit" a
 *     deliberate act, not a surprise side-effect.
 */
function SessionActionBar({
  session,
  onConfirm,
  onUnconfirm,
  onCancel,
  confirming,
  unconfirming,
  cancelling,
}: {
  session: SessionData;
  onConfirm: () => void;
  onUnconfirm: () => void;
  onCancel: () => void;
  confirming: boolean;
  unconfirming: boolean;
  cancelling: boolean;
}) {
  const counterpartHandle = session.counterpart?.handle ?? null;
  const bothEmpty = session.yourCards.length === 0 && session.theirCards.length === 0;
  const viewerConfirmed = session.confirmedByViewer;
  // Disable Confirm with an inline hint when the canvas is empty —
  // settling a trade with no cards isn't a real transaction.
  const confirmDisabled = confirming || bothEmpty;

  return (
    <section className="rounded-xl border border-space-700 bg-space-800/40 p-3 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 text-[11px] text-gray-400 leading-relaxed">
        {bothEmpty ? (
          <>Add cards on at least one side before confirming.</>
        ) : viewerConfirmed ? (
          <>You've confirmed. Tap Unconfirm to edit your side again, or wait for @{counterpartHandle ?? 'your counterpart'} to confirm and settle this trade.</>
        ) : session.confirmedByCounterpart ? (
          <>@{counterpartHandle ?? 'Your counterpart'} already confirmed. Confirm to lock this trade in.</>
        ) : (
          <>Happy with both sides? Confirm to lock it in. Both of you have to confirm to settle.</>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="px-3 h-10 rounded-lg border border-red-700/60 text-red-300 hover:bg-red-950/40 disabled:opacity-60 text-xs font-medium"
        >
          Cancel trade
        </button>
        {viewerConfirmed ? (
          <button
            type="button"
            onClick={onUnconfirm}
            disabled={unconfirming}
            className="px-4 h-10 rounded-lg border border-gold/50 text-gold hover:bg-gold/10 disabled:opacity-60 text-xs font-bold"
          >
            Unconfirm to edit
          </button>
        ) : (
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className="px-4 h-10 rounded-lg bg-emerald-500 text-space-900 font-bold hover:bg-emerald-400 disabled:opacity-60 text-xs"
          >
            Confirm trade
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Mid-canvas strip surfacing who has confirmed on an active session.
 * Rendered between the identity strip and the TradeBalance so the
 * commitment state is visually adjacent to the cards that were
 * committed. Exactly one partial-confirmation state reaches this
 * strip — the "both confirmed" case settles the session immediately
 * and routes through TerminalBanner instead.
 */
function CommitmentStrip({
  viewerConfirmed,
  counterpartHandle,
}: {
  viewerConfirmed: boolean;
  counterpartHandle: string | null;
}) {
  if (viewerConfirmed) {
    return (
      <section className="rounded-lg border border-gold/40 bg-gold/10 px-3 py-2 flex items-center gap-2">
        <LockIcon className="w-3.5 h-3.5 text-gold shrink-0" />
        <div className="text-[12px] text-gold-bright font-semibold">
          You've confirmed.
          <span className="text-gold font-normal">
            {' '}Waiting on @{counterpartHandle ?? 'your counterpart'} to lock the trade in.
          </span>
        </div>
      </section>
    );
  }
  // Counterpart-only confirmed (parent gate excludes neither-confirmed
  // and both-confirmed settles before reaching this render path).
  return (
    <section className="rounded-lg border border-cyan-500/40 bg-cyan-950/30 px-3 py-2 flex items-center gap-2">
      <LockIcon className="w-3.5 h-3.5 text-cyan-300 shrink-0" />
      <div className="text-[12px] text-cyan-200 font-semibold">
        @{counterpartHandle ?? 'Your counterpart'} confirmed.
        <span className="text-cyan-300/80 font-normal">
          {' '}Confirm below to settle this trade.
        </span>
      </div>
    </section>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

function Badge({ tone, children }: { tone: 'emerald' | 'cyan' | 'neutral'; children: React.ReactNode }) {
  const cls = tone === 'emerald'
    ? 'bg-emerald-900/40 border-emerald-500/40 text-emerald-300'
    : tone === 'cyan'
      ? 'bg-cyan-900/30 border-cyan-500/40 text-cyan-200'
      : 'bg-space-700/60 border-space-600 text-gray-400';
  return (
    <span className={`px-2 h-6 inline-flex items-center rounded-md border text-[10px] tracking-wider uppercase font-bold ${cls}`}>
      {children}
    </span>
  );
}

function ConfirmBadge({ label, confirmed }: { label: string; confirmed: boolean }) {
  if (confirmed) {
    return (
      <span className="inline-flex items-center gap-1 px-2 h-6 rounded-md border border-emerald-500/40 bg-emerald-900/30 text-emerald-300 text-[11px] font-semibold">
        <CheckGlyph />
        {label} confirmed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 h-6 rounded-md border border-space-600 bg-space-800/60 text-gray-500 text-[11px]">
      Awaiting {label}
    </span>
  );
}

function CheckGlyph() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8l3 3 6-6" />
    </svg>
  );
}

function CounterpartAvatar({ avatarUrl, name }: { avatarUrl: string | null; name: string }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="w-10 h-10 rounded-full shrink-0" />;
  }
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className="w-10 h-10 rounded-full bg-space-700 text-gold font-bold flex items-center justify-center shrink-0"
    >
      {initial}
    </span>
  );
}

// Dispatched to readOnly TradeSide's Add/Remove/ChangeQty props. Every
// path that fires them is gated behind `!readOnly`, so these are
// strictly placeholder satisfiers for the prop contract.
function noop() {
  /* intentional — readOnly gates every handler call site */
}

// --- Ghost sign-in CTA ----------------------------------------------------

/**
 * Shown when the current viewer joined as an anonymous ghost — nudges
 * them to sign in so this trade survives beyond the ghost cookie's
 * TTL. Discord OAuth callback handles the ghost → real migration,
 * rewriting every trade_sessions row this ghost is in over to the
 * signed-in user before swapping the cookie.
 */
function GhostSignInBanner({ onSignIn }: { onSignIn: () => void }) {
  return (
    <section className="rounded-lg border border-gold/40 bg-gold/8 px-4 py-3 flex items-center gap-3 flex-wrap">
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-semibold text-gold">
          You're signed in as a guest
        </div>
        <div className="text-[11px] text-gray-300 mt-0.5">
          Sign in with Discord to keep this trade and see it on Home later.
        </div>
      </div>
      <button
        type="button"
        onClick={onSignIn}
        className="shrink-0 px-3 h-9 rounded-lg bg-gold text-space-900 font-bold text-xs hover:bg-gold-bright transition-colors"
      >
        Sign in with Discord
      </button>
    </section>
  );
}

// --- Invite flows ---------------------------------------------------------

/**
 * Shown to a VIEWER who isn't a session participant but the session
 * has an open slot — e.g., someone scanned a QR code at the game
 * store. Surfaces the creator's identity and a single primary
 * action: Join. Anonymous visitors get a ghost user minted behind
 * the scenes + a "sign in to keep this trade" hint for later.
 */
function InvitePrompt({
  preview,
  onClaim,
  claiming,
}: {
  preview: SessionPreview;
  onClaim: () => Promise<void> | void;
  claiming: boolean;
}) {
  const { user } = useAuthContext();
  return (
    <section className="rounded-xl border border-cyan-500/40 bg-cyan-950/20 p-6 max-w-xl mx-auto w-full flex flex-col items-center text-center gap-4">
      <div className="flex flex-col items-center gap-2">
        <CounterpartAvatar
          avatarUrl={preview.creator.avatarUrl}
          name={preview.creator.username || preview.creator.handle}
        />
        <div>
          <div className="text-[11px] tracking-[0.18em] uppercase text-cyan-300 font-bold">
            You're invited to a trade
          </div>
          <div className="text-base font-semibold text-gray-100 mt-0.5">
            @{preview.creator.handle}
            {preview.creator.isAnonymous && (
              <span className="ml-2 text-[11px] text-gray-500 font-normal">(guest)</span>
            )}
          </div>
        </div>
      </div>
      <p className="text-sm text-gray-300 leading-relaxed max-w-sm">
        {preview.creatorCardCount > 0
          ? <>They've started a trade with {preview.creatorCardCount} card{preview.creatorCardCount === 1 ? '' : 's'} on their side. Join to see what they're offering and add your own cards.</>
          : <>They've started a trade and invited you to fill in your side. Join to build it together.</>}
      </p>
      {!user && (
        <div className="text-[11px] text-gray-400 leading-relaxed max-w-sm">
          You can join as a guest — no account needed. Sign in later to save this trade to your SWUTrade account.
        </div>
      )}
      <button
        type="button"
        onClick={() => void onClaim()}
        disabled={claiming}
        className="px-6 h-10 rounded-lg bg-cyan-500 text-space-900 font-bold hover:bg-cyan-400 disabled:opacity-60 text-sm"
      >
        {claiming ? 'Joining…' : 'Join this trade'}
      </button>
    </section>
  );
}

/**
 * Shown to the CREATOR of an open-slot session (viewer is slot A,
 * slot B null) — renders the QR code + shareable URL + a link to
 * copy. Creator can edit their half while waiting for a claim;
 * cancelling the session closes the invite.
 *
 * QR encodes the absolute URL of this page so a scanning phone
 * opens the same route; the scanner either sees the InvitePrompt
 * (non-participant, anon/signed-in) or — if they happen to already
 * be signed in as the creator's counterpart — the full session.
 */
function OpenSlotInvite({
  sessionId,
  viewerIsGhost,
  onCancel,
}: {
  sessionId: string;
  viewerIsGhost: boolean;
  onCancel: () => Promise<void> | void;
}) {
  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/s/${encodeURIComponent(sessionId)}`
    : `/s/${sessionId}`;
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions / http context) —
      // fallback is the manually-selectable URL in the textbox below.
    }
  }, [shareUrl]);

  return (
    <section className="rounded-xl border border-cyan-500/40 bg-cyan-950/20 p-6 max-w-xl mx-auto w-full flex flex-col items-center gap-4">
      <div className="text-center">
        <div className="text-[11px] tracking-[0.18em] uppercase text-cyan-300 font-bold">
          Waiting for your counterpart
        </div>
        <div className="text-base font-semibold text-gray-100 mt-0.5">
          Share this QR or link
        </div>
      </div>
      <div className="p-3 bg-white rounded-lg">
        <QRCodeSVG value={shareUrl} size={192} />
      </div>
      <div className="w-full flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={shareUrl}
          onFocus={e => e.currentTarget.select()}
          className="flex-1 min-w-0 bg-space-800 border border-space-700 rounded-md px-3 h-9 text-[12px] text-gray-200 font-mono"
        />
        <button
          type="button"
          onClick={handleCopy}
          className="px-3 h-9 rounded-md bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/30 text-xs font-semibold"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-[12px] text-gray-400 text-center max-w-sm leading-relaxed">
        They can scan the QR from their phone, or open the link. They can join as a guest — no sign-in required.
      </p>

      {/* Alternative invite path — type a handle, the server sends
          the URL as a Discord DM. Ghost creators don't have a Discord
          identity to originate the DM from, so we hide the form for
          them and they stay on the QR/share-link path. */}
      {!viewerIsGhost && (
        <InviteByHandleForm sessionId={sessionId} />
      )}

      <button
        type="button"
        onClick={() => void onCancel()}
        className="text-[11px] text-gray-500 hover:text-red-300 underline transition-colors"
      >
        Cancel this invitation
      </button>
    </section>
  );
}

/**
 * Secondary invite path rendered under the QR / share-link. The
 * creator types a SWUTrade handle, clicks Invite, and the server DMs
 * that user the session URL. No pre-claim; the invitee still has to
 * click through. This is a side effect — we deliberately do NOT
 * re-render the session on success. The slot stays open; when they
 * eventually join via the URL the existing claim flow handles it.
 */
function InviteByHandleForm({ sessionId }: { sessionId: string }) {
  const [handle, setHandle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    const trimmed = handle.trim().replace(/^@+/, '');
    if (!trimmed) {
      setErrorMessage('Enter a SWUTrade handle to invite.');
      setSuccessMessage(null);
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/invite-handle`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ handle: trimmed }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { invited?: { handle: string }; error?: string }
        | null;
      if (!res.ok) {
        setErrorMessage(body?.error ?? 'Could not send the invite. Try again.');
        return;
      }
      const invitedHandle = body?.invited?.handle ?? trimmed;
      setSuccessMessage(`Invited @${invitedHandle} — they'll get a Discord DM.`);
      setHandle('');
    } catch {
      setErrorMessage('Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }, [handle, sessionId, submitting]);

  return (
    <div className="w-full flex flex-col gap-2 pt-2 border-t border-space-700">
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-gray-500 font-bold">
        <span className="flex-1 h-px bg-space-700" aria-hidden />
        <span>or</span>
        <span className="flex-1 h-px bg-space-700" aria-hidden />
      </div>
      <div className="text-[12px] text-gray-300 font-semibold text-center">
        Invite by handle
      </div>
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          type="text"
          placeholder="@handle"
          value={handle}
          onChange={e => {
            setHandle(e.currentTarget.value);
            // Clear stale feedback as soon as they start editing
            // again — the old message no longer reflects input state.
            if (errorMessage) setErrorMessage(null);
            if (successMessage) setSuccessMessage(null);
          }}
          disabled={submitting}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-0 bg-space-800 border border-space-700 rounded-md px-3 h-9 text-[13px] text-gray-200 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={submitting || handle.trim().length === 0}
          className="px-3 h-9 rounded-md bg-cyan-500 text-space-900 font-bold hover:bg-cyan-400 disabled:opacity-60 text-xs"
        >
          {submitting ? 'Inviting…' : 'Invite'}
        </button>
      </form>
      {successMessage && (
        <div className="text-[11px] text-emerald-300">{successMessage}</div>
      )}
      {errorMessage && (
        <div className="text-[11px] text-red-400">{errorMessage}</div>
      )}
    </div>
  );
}

// --- helpers --------------------------------------------------------------

function stubCard(snap: TradeCardSnapshot): CardVariant {
  // Minimal CardVariant when the product id isn't in our card index.
  // TradeSide reads name + productId + set + prices; everything else
  // defaults. For an unknown card the set slug is "?" — TradeRow's
  // tolerant renderer handles this without crashing.
  return {
    productId: snap.productId,
    name: snap.name,
    set: '?',
    marketPrice: snap.unitPrice ?? null,
    lowPrice: snap.unitPrice ?? null,
  } as CardVariant;
}

function snapshotFromCardVariant(card: CardVariant, qty: number): TradeCardSnapshot {
  return {
    productId: card.productId || card.name,
    name: card.name,
    variant: extractVariantLabel(card.name) || 'Standard',
    qty,
    unitPrice: card.marketPrice ?? null,
  };
}

function snapshotsToTradeCards(
  snaps: CardSnapshot[],
  byProductId: Map<string, CardVariant>,
): TradeCard[] {
  return snaps.map(snap => ({
    card: byProductId.get(snap.productId) ?? stubCard(snap),
    qty: snap.qty,
  }));
}
