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
import { PERSIST_KEYS } from '../persistence';
import type { TradeCard, CardVariant } from '../types';
import type { CardSnapshot } from '../hooks/useTradeDetail';
type TradeCardSnapshot = CardSnapshot;
import { extractVariantLabel } from '../variants';

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
  const { listsDrawerOpen, setListsDrawerOpen, openLists } = useDrawerContext();
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
  const { session, preview, status, saveCards, confirm, cancel, claim, hasUnseenCounterpartEdit, markCounterpartSeen } = api;
  const [claiming, setClaiming] = useState(false);

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
    // TradeSide's key is tradeCardKey(card) = `${productId||name}-${set}`.
    // We keyed our snapshots by productId, so strip the trailing -set.
    const productId = key.split('-').slice(0, -1).join('-') || key;
    const next = viewerSnapshotsRef.current.filter(s => s.productId !== productId);
    writeCards(next);
  }, [writeCards]);

  const handleChangeQty = useCallback((key: string, delta: number) => {
    const productId = key.split('-').slice(0, -1).join('-') || key;
    const next = viewerSnapshotsRef.current
      .map(s => s.productId === productId ? { ...s, qty: s.qty + delta } : s)
      .filter(s => s.qty > 0);
    writeCards(next);
  }, [writeCards]);

  const handleLoadAllSets = useCallback(() => {
    priceData.loadAllSets();
  }, [priceData]);

  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const handleConfirm = useCallback(async () => {
    if (confirming || !session || session.status !== 'active') return;
    setConfirming(true);
    try {
      await confirm();
    } finally {
      setConfirming(false);
    }
  }, [confirm, confirming, session]);
  const handleCancel = useCallback(async () => {
    if (cancelling || !session || session.status !== 'active') return;
    if (!window.confirm('Cancel this shared trade? Both sides will lose the in-progress state.')) return;
    setCancelling(true);
    try {
      await cancel();
    } finally {
      setCancelling(false);
    }
  }, [cancel, cancelling, session]);

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <AppHeader auth={auth} breadcrumbs={breadcrumbs} onOpenLists={openLists} />

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
              <SessionIdentityStrip session={session} />

              {terminal ? (
                <TerminalBanner session={session} />
              ) : hasUnseenCounterpartEdit ? (
                <button
                  type="button"
                  onClick={markCounterpartSeen}
                  className="w-full text-left px-3 py-2 rounded-lg border border-cyan-500/40 bg-cyan-950/30 text-[12px] text-cyan-200 hover:bg-cyan-950/50 transition-colors"
                >
                  @{counterpartHandle ?? 'Your counterpart'} made changes. Tap to dismiss.
                </button>
              ) : null}

              <TradeBalance
                yourCards={viewerTradeCards}
                theirCards={counterpartCards}
              />

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
                  borderColor="border-emerald-500/20"
                  setCards={priceData.cards}
                  isLoading={priceData.isAnyLoading}
                  onLoadAllSets={handleLoadAllSets}
                  filters={filters}
                  wants={wants}
                  available={available}
                  sharedLists={null}
                  collapsed={false}
                  counterpartHandle={counterpartHandle}
                  readOnly={terminal}
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
                  borderColor="border-blue-500/20"
                  setCards={priceData.cards}
                  isLoading={priceData.isAnyLoading}
                  onLoadAllSets={handleLoadAllSets}
                  filters={filters}
                  wants={wants}
                  available={available}
                  sharedLists={null}
                  collapsed={false}
                  counterpartHandle={counterpartHandle}
                  readOnly
                  readOnlyEmptyLabel={
                    counterpartHandle
                      ? `Waiting for @${counterpartHandle} to add cards.`
                      : 'Waiting for your counterpart to add cards.'
                  }
                />
              </div>

              {!terminal && (
                <SessionActionBar
                  session={session}
                  onConfirm={handleConfirm}
                  onCancel={handleCancel}
                  confirming={confirming}
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
    </div>
  );
}

// --- Identity + status strip (top) ---------------------------------------

/**
 * Top strip — identifies the counterpart and surfaces the lifecycle
 * state. Never carries the Confirm / Cancel buttons: those belong
 * below the cards so the flow reads as stage → confirm.
 */
function SessionIdentityStrip({ session }: { session: SessionData }) {
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
      </div>
    </section>
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
function TerminalBanner({ session }: { session: SessionData }) {
  const counterpartHandle = session.counterpart?.handle ?? null;
  if (session.status === 'settled') {
    const when = session.settledAt ?? session.updatedAt;
    return (
      <section className="rounded-lg border border-emerald-500/40 bg-emerald-900/20 px-4 py-3">
        <div className="text-[11px] tracking-[0.18em] uppercase text-emerald-300 font-bold">
          Trade settled
        </div>
        <div className="text-sm text-gray-200 mt-0.5">
          Both of you confirmed on {formatTerminalDate(when)}. This trade is locked — no more edits.
        </div>
      </section>
    );
  }
  if (session.status === 'cancelled') {
    return (
      <section className="rounded-lg border border-space-600 bg-space-800/60 px-4 py-3">
        <div className="text-[11px] tracking-[0.18em] uppercase text-gray-400 font-bold">
          Trade cancelled
        </div>
        <div className="text-sm text-gray-300 mt-0.5">
          This trade was cancelled{counterpartHandle ? ` — either you or @${counterpartHandle} closed it out` : ''}. No more edits.
        </div>
      </section>
    );
  }
  // expired
  return (
    <section className="rounded-lg border border-space-600 bg-space-800/60 px-4 py-3">
      <div className="text-[11px] tracking-[0.18em] uppercase text-gray-400 font-bold">
        Trade expired
      </div>
      <div className="text-sm text-gray-300 mt-0.5">
        This trade expired from inactivity. No more edits — start a fresh one if you still want to trade.
      </div>
    </section>
  );
}

function formatTerminalDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// --- Action bar (below cards) --------------------------------------------

/**
 * Confirm + Cancel live HERE, below the cards, because the flow is
 * stage → confirm. Only renders when the session is active; terminal
 * states drop the bar entirely.
 */
function SessionActionBar({
  session,
  onConfirm,
  onCancel,
  confirming,
  cancelling,
}: {
  session: SessionData;
  onConfirm: () => void;
  onCancel: () => void;
  confirming: boolean;
  cancelling: boolean;
}) {
  const counterpartHandle = session.counterpart?.handle ?? null;
  const bothEmpty = session.yourCards.length === 0 && session.theirCards.length === 0;
  // Disable Confirm with an inline hint when the canvas is empty —
  // settling a trade with no cards isn't a real transaction.
  const confirmDisabled =
    confirming || session.confirmedByViewer || bothEmpty;
  const confirmLabel = session.confirmedByViewer
    ? `Waiting on @${counterpartHandle ?? 'them'}`
    : 'Confirm trade';
  return (
    <section className="rounded-xl border border-space-700 bg-space-800/40 p-3 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 text-[11px] text-gray-400 leading-relaxed">
        {bothEmpty ? (
          <>Add cards on at least one side before confirming.</>
        ) : session.confirmedByViewer ? (
          <>You've confirmed. Waiting on @{counterpartHandle ?? 'them'} — they still need to confirm to lock in this trade.</>
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
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          className="px-4 h-10 rounded-lg bg-emerald-500 text-space-900 font-bold hover:bg-emerald-400 disabled:opacity-60 text-xs"
        >
          {confirmLabel}
        </button>
      </div>
    </section>
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
      {label} not confirmed
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
