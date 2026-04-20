import { useCallback, useMemo, useRef, useState } from 'react';
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
import { useIsMobile } from '../hooks/useMediaQuery';
import { useSession, type SessionView as SessionData } from '../hooks/useSession';
import { PERSIST_KEYS } from '../persistence';
import type { TradeCard, CardVariant } from '../types';
import type { CardSnapshot } from '../hooks/useTradeDetail';
type TradeCardSnapshot = CardSnapshot;
import { cardImageUrl } from '../services/priceService';
import { extractBaseName, extractVariantLabel } from '../variants';
import { VariantBadge } from './VariantBadge';

/**
 * Shared-state trade canvas — the interactive surface for a session
 * between two signed-in users. Mounts at `/s/<id>`.
 *
 * Layout mirrors the main trade builder so the primitive feels
 * unified: two panels, balance strip at the bottom. Differences from
 * the Solo (calculator) view:
 *   - The LEFT panel is the viewer's editable half, powered by the
 *     existing TradeSide component + `useSession.saveCards`.
 *   - The RIGHT panel shows the counterpart's cards read-only — they
 *     own their half and edit it from their own browser.
 *   - An action strip above the panels carries live-indicator, last-
 *     edited timestamp, Confirm, and Cancel.
 *   - A banner fires when the counterpart has edited since the
 *     viewer last saw it (dismissed by scrolling or clicking through).
 *   - Settled / cancelled / expired states freeze the UI into a
 *     terminal banner with a link back to My Trades.
 */
export function SessionView({ sessionId }: { sessionId: string }) {
  const auth = useAuthContext();
  const priceData = usePriceDataContext();
  const cardIndex = useCardIndexContext();
  const { listsDrawerOpen, setListsDrawerOpen, openLists } = useDrawerContext();
  const { percentage, priceMode } = usePricing();
  const wants = useWants();
  const available = useAvailable();
  const isMobile = useIsMobile();
  // Fresh filter state per session — doesn't share with the main
  // trade builder so session-specific variant/set scope doesn't
  // bleed back into the user's calculator when they navigate home.
  const filters = useSelectionFilters({
    variants: PERSIST_KEYS.tradeSelVariants,
    sets: PERSIST_KEYS.tradeSelSets,
  });

  const api = useSession(sessionId);
  const { session, status, saveCards, confirm, cancel, hasUnseenCounterpartEdit, markCounterpartSeen } = api;

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
        {status === 'loading' && !session && <LoadingState label="Loading shared trade…" />}
        {status === 'error' && !session && (
          <ErrorState>Couldn't load this trade. Try refreshing.</ErrorState>
        )}
        {status === 'not-found' && (
          <ErrorState>
            This shared trade doesn't exist or you're not a participant. It may have been cancelled or expired.
          </ErrorState>
        )}

        {session && (
          <>
            <SessionHeader
              session={session}
              onConfirm={handleConfirm}
              onCancel={handleCancel}
              confirming={confirming}
              cancelling={cancelling}
            />

            {hasUnseenCounterpartEdit && (
              <button
                type="button"
                onClick={markCounterpartSeen}
                className="w-full text-left px-3 py-2 rounded-lg border border-cyan-500/40 bg-cyan-950/30 text-[12px] text-cyan-200 hover:bg-cyan-950/50 transition-colors"
              >
                @{session.counterpart?.handle ?? 'Your counterpart'} made changes. Tap to dismiss.
              </button>
            )}

            <TradeBalance
              yourCards={viewerTradeCards}
              theirCards={snapshotsToTradeCards(session.theirCards, byProductId)}
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
                onToggleCollapse={isMobile ? undefined : undefined}
                counterpartHandle={session.counterpart?.handle ?? null}
              />
              <ReadonlyCounterpartSide session={session} />
            </div>
          </>
        )}
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

// --- Header + action strip -------------------------------------------------

function SessionHeader({
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

      {active && (
        <div className="flex items-center gap-2 sm:ml-auto">
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            className="px-3 h-9 rounded-lg border border-red-700/60 text-red-300 hover:bg-red-950/40 disabled:opacity-60 text-xs font-medium"
          >
            Cancel trade
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming || session.confirmedByViewer}
            className="px-4 h-9 rounded-lg bg-emerald-500 text-space-900 font-bold hover:bg-emerald-400 disabled:opacity-60 text-xs"
          >
            {session.confirmedByViewer ? 'Waiting on @' + (counterpart?.handle ?? '…') : 'Confirm'}
          </button>
        </div>
      )}
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

// --- Read-only counterpart side -------------------------------------------

function ReadonlyCounterpartSide({ session }: { session: SessionData }) {
  const cards = session.theirCards;
  const total = cards.reduce((n, c) => n + c.qty, 0);
  const counterpartHandle = session.counterpart?.handle ?? 'counterpart';
  return (
    <div className="rounded-xl border border-blue-500/20 bg-space-800/40 flex flex-col min-h-[16rem]">
      <div className="flex items-baseline justify-between px-4 py-3 border-b border-space-700">
        <div className="flex flex-col">
          <span className="text-[11px] tracking-[0.18em] uppercase text-blue-300 font-bold">
            @{counterpartHandle} offers
          </span>
          <span className="text-[10px] text-gray-500 mt-0.5">Read-only — they own this side</span>
        </div>
        <span className="text-[11px] text-gray-500 tabular-nums">
          {total} {total === 1 ? 'card' : 'cards'}
        </span>
      </div>
      {cards.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-600 px-4 py-12 text-center">
          Waiting for @{counterpartHandle} to add cards.
        </div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-3">
          {cards.map((c, idx) => (
            <CounterpartTile key={`${c.productId}-${idx}`} snap={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function CounterpartTile({ snap }: { snap: TradeCardSnapshot }) {
  const [errored, setErrored] = useState(false);
  const src = cardImageUrl(snap.productId, 'md');
  const baseName = extractBaseName(snap.name);
  const variantLabel = extractVariantLabel(snap.name) || snap.variant;
  return (
    <div
      className="relative rounded-md overflow-hidden border border-space-700 bg-space-900/80"
      title={`${snap.name}${snap.qty > 1 ? ` × ${snap.qty}` : ''}`}
    >
      <div className="relative w-full aspect-[5/7] bg-space-900">
        {src && !errored ? (
          <img
            src={src}
            alt={snap.name}
            loading="lazy"
            onError={() => setErrored(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-lg">?</div>
        )}
        {snap.qty > 1 && (
          <span className="absolute top-1 right-1 min-w-[22px] h-[18px] px-1.5 rounded-full flex items-center justify-center text-[10px] font-bold tabular-nums bg-black/85 text-white ring-1 ring-blue-400/70">
            ×{snap.qty}
          </span>
        )}
      </div>
      <div className="px-1.5 py-1 leading-tight">
        <div className="text-[10px] text-gray-300 truncate">{baseName}</div>
        {variantLabel && (
          <VariantBadge
            variant={variantLabel}
            size="xs"
            className="inline-block max-w-full truncate align-middle"
          />
        )}
      </div>
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
