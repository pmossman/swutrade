import { useCallback, useMemo, useState } from 'react';
import type { AuthApi } from '../hooks/useAuth';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import type { CardVariant, PriceMode } from '../types';
import { cardFamilyId } from '../variants';
import { AppHeader } from './ui/AppHeader';
import { WantsPanel } from './lists/WantsPanel';
import { AvailablePanel } from './lists/AvailablePanel';
import { TradeImageModal } from './TradeImageModal';
import { useShareListLink, type ShareListKind } from '../hooks/useShareListLink';

/**
 * Unified "Your collection" view — merges the previously-separate
 * Wishlist and Trade Binder dedicated views into one tabbed surface.
 * Reached from Home's modules or NavMenu; tab is URL-synced via
 * `?tab=wishlist|binder` so a deep-link from another part of the
 * app (e.g. a trader-match badge) lands on the right list.
 *
 * Why merged: parker flagged 2026-05-21 that the physical-collection
 * audit workflow (card in hand → "do I want this?" → "do I have
 * extras?") was bouncing users back through Home to switch lists.
 * Tabs collapse the switch to one tap, and the chrome was already
 * 80% identical between the two views — separation was historical
 * (one was added before the other) rather than load-bearing.
 *
 * Tab state honors `?tab=` on mount + writes back via replaceState
 * on switch — same pattern ProfileView uses for its Wants/Available
 * tabs. Per-tab toolbar state still persists via the existing
 * `swu.listToolbar.wishlist` / `swu.listToolbar.binder` keys (the
 * panels haven't changed, just the host).
 */
export type CollectionTab = 'wishlist' | 'binder';

interface CollectionViewProps {
  auth: AuthApi;
  wants: WantsApi;
  available: AvailableApi;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
  /** Tab to open with when there's no `?tab=` in the URL. Set by
   *  the App-level routing path that funnels the legacy
   *  `?view=wishlist` / `?view=binder` URLs into this view. */
  defaultTab?: CollectionTab;
}

const VALID_TABS: ReadonlySet<string> = new Set(['wishlist', 'binder']);

function readInitialTab(defaultTab: CollectionTab): CollectionTab {
  if (typeof window === 'undefined') return defaultTab;
  const raw = new URLSearchParams(window.location.search).get('tab');
  return raw && VALID_TABS.has(raw) ? (raw as CollectionTab) : defaultTab;
}

export function CollectionView({
  auth,
  wants,
  available,
  allCards,
  percentage,
  priceMode,
  defaultTab = 'wishlist',
}: CollectionViewProps) {
  const [tab, setTab] = useState<CollectionTab>(() => readInitialTab(defaultTab));

  const onSelectTab = useCallback((next: CollectionTab) => {
    setTab(next);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    // replaceState (vs pushState) so a tab toggle doesn't pollute
    // history. The back button stays useful: it returns the user to
    // wherever they came from before opening the collection.
    window.history.replaceState(null, '', url.toString());
  }, []);

  // Catalog indexes — same shape as the previous separate views.
  const { byFamily, byFamilyAll, byProductId } = useMemo(() => {
    const byFamily = new Map<string, CardVariant>();
    const byFamilyAll = new Map<string, CardVariant[]>();
    const byProductId = new Map<string, CardVariant>();
    for (const card of allCards) {
      const fid = cardFamilyId(card);
      const existing = byFamily.get(fid);
      if (!existing || card.variant === 'Standard') byFamily.set(fid, card);
      const bucket = byFamilyAll.get(fid);
      if (bucket) bucket.push(card);
      else byFamilyAll.set(fid, [card]);
      if (card.productId) byProductId.set(card.productId, card);
    }
    return { byFamily, byFamilyAll, byProductId };
  }, [allCards]);

  const wantsCount = wants.items.length;
  const priorityCount = useMemo(
    () => wants.items.filter(w => w.isPriority).length,
    [wants.items],
  );
  const availableCount = available.items.length;

  const isWishlist = tab === 'wishlist';

  return (
    <div className="h-[100dvh] overflow-hidden bg-space-900 text-gray-100 flex flex-col">
      <AppHeader
        auth={auth}
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: isWishlist ? 'Wishlist' : 'Trade binder' },
        ]}
      />

      <main className="flex-1 min-h-0 flex flex-col max-w-3xl mx-auto w-full px-3 sm:px-6 pb-6 pt-3">
        {/* Tab bar — blue/emerald accents mirror the trade-side palette
            (wants = receiving = blue, available = offering = emerald),
            matching the convention used in ProfileView's tab bar. The
            count badge per tab gives an at-a-glance summary without
            having to flip. */}
        <div
          role="tablist"
          aria-label="Your collection"
          className="flex gap-6 border-b border-space-800 mb-3"
        >
          <CollectionTabTrigger
            tab="wishlist"
            active={isWishlist}
            label="Wishlist"
            count={wantsCount}
            priorityCount={priorityCount}
            onSelect={onSelectTab}
          />
          <CollectionTabTrigger
            tab="binder"
            active={!isWishlist}
            // Tab label "Binder" on mobile, "Trade binder" on
            // desktop — the heavy tracking + the count badge
            // make the full label wrap at 375px. Breadcrumb still
            // shows the full "Trade binder" so vocabulary stays
            // canonical at the view level.
            label="Binder"
            labelDesktop="Trade binder"
            count={availableCount}
            onSelect={onSelectTab}
          />
          <div className="ml-auto self-center">
            <ShareSection
              kind={isWishlist ? 'wants' : 'available'}
              items={isWishlist ? wants.items : available.items}
            />
          </div>
        </div>

        {/* Panel body — fills remaining viewport. Keeping both
            mounted at all times would let toolbar state survive
            switches even more naturally, but conditional render is
            simpler and matches ProfileView; the panels' toolbar
            state already persists via localStorage. */}
        <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-space-800 bg-space-900 overflow-hidden">
          {isWishlist ? (
            <WantsPanel
              wants={wants}
              allCards={allCards}
              percentage={percentage}
              priceMode={priceMode}
              byFamily={byFamily}
              byFamilyAll={byFamilyAll}
              emptyState={{
                title: 'Your wishlist is empty',
                body: "Add cards you're hunting for. Matchmaking against other traders' binders will find them.",
              }}
            />
          ) : (
            <AvailablePanel
              available={available}
              allCards={allCards}
              percentage={percentage}
              priceMode={priceMode}
              byProductId={byProductId}
              emptyState={{
                title: 'Your trade binder is empty',
                body: 'Add cards you have available to trade. Matchmaking will surface them to other traders looking for matches.',
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function CollectionTabTrigger({
  tab,
  active,
  label,
  labelDesktop,
  count,
  priorityCount,
  onSelect,
}: {
  tab: CollectionTab;
  active: boolean;
  label: string;
  labelDesktop?: string;
  count: number;
  priorityCount?: number;
  onSelect: (next: CollectionTab) => void;
}) {
  const activeAccent = tab === 'wishlist'
    ? 'text-blue-300 border-blue-400'
    : 'text-emerald-300 border-emerald-400';
  const activeBadge = tab === 'wishlist'
    ? 'bg-blue-500/15 text-blue-200 border-blue-400/40'
    : 'bg-emerald-500/15 text-emerald-200 border-emerald-400/40';
  const inactive = 'text-gray-500 border-transparent hover:text-gray-300';
  const inactiveBadge = 'bg-space-800/60 text-gray-400 border-space-700';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(tab)}
      className={`flex items-baseline gap-2 pb-2 -mb-[3px] border-b-[3px] transition-colors ${
        active ? activeAccent : inactive
      }`}
    >
      <span className="text-xs sm:text-sm font-bold tracking-wider sm:tracking-[0.18em] uppercase whitespace-nowrap">
        {labelDesktop ? (
          <>
            <span className="sm:hidden">{label}</span>
            <span className="hidden sm:inline">{labelDesktop}</span>
          </>
        ) : label}
      </span>
      <span className={`text-[10px] px-1.5 py-px rounded-full border font-semibold ${active ? activeBadge : inactiveBadge}`}>
        {count}
      </span>
      {priorityCount !== undefined && priorityCount > 0 && (
        <span className="text-[10px] text-gold-bright font-semibold">
          {priorityCount}★
        </span>
      )}
    </button>
  );
}

/**
 * Share affordances — "Copy link" + "Share image". Shares ONLY the
 * active tab's list (wants OR available, not both) so a wishlist
 * share lands the recipient on a wishlist-scoped shared-list view,
 * a binder share lands them on the inverse. The image preview lives
 * in `TradeImageModal` (same component the in-trade share flow uses);
 * the OG image URL is built off `/api/og?w=…` or `?a=…` so the
 * server-rendered preview matches what the recipient sees on landing.
 *
 * Hidden when the active list is empty — nothing to share.
 */
function ShareSection({
  kind,
  items,
}: {
  kind: ShareListKind;
  items: WantsApi['items'] | AvailableApi['items'];
}) {
  const { shareUrl, handleCopy, copied } = useShareListLink(kind, items);
  const [showImage, setShowImage] = useState(false);

  const imageUrl = useCallback(() => {
    const url = shareUrl();
    const params = new URLSearchParams();
    const key = kind === 'wants' ? 'w' : 'a';
    const val = url.searchParams.get(key);
    if (val) params.set(key, val);
    const pct = url.searchParams.get('pct');
    const pm = url.searchParams.get('pm');
    if (pct) params.set('pct', pct);
    if (pm) params.set('pm', pm);
    return `/api/og?${params.toString()}`;
  }, [shareUrl, kind]);

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-2 shrink-0">
      {/* Copy link: icon-only on mobile (just the paper-airplane),
          icon + label on sm+ so the action stays scannable at
          desktop width but doesn't wrap into a two-line button
          on a 375px viewport. */}
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Link copied' : 'Copy share link'}
        title={copied ? 'Link copied' : 'Copy share link'}
        className="inline-flex items-center justify-center gap-1.5 px-2 sm:px-3 h-8 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-semibold text-gray-300 hover:text-gold transition-colors"
      >
        {copied ? (
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-gold" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 8l3 3 7-7" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14 2L7 9" />
            <path d="M14 2l-5 12-2-5-5-2 12-5z" />
          </svg>
        )}
        <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy link'}</span>
      </button>
      <button
        type="button"
        onClick={() => setShowImage(true)}
        className="hidden sm:inline-flex px-3 h-8 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-semibold text-gray-300 hover:text-gold transition-colors"
      >
        Share image
      </button>
      {showImage && (
        <TradeImageModal
          imageUrl={imageUrl()}
          onClose={() => setShowImage(false)}
        />
      )}
    </div>
  );
}
