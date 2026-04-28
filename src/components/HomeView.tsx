import { useMemo, useState } from 'react';
import {
  AlarmClock,
  ArrowLeftRight,
  BookOpen,
  Handshake,
  Star,
  Users,
} from 'lucide-react';
import type { AuthApi } from '../hooks/useAuth';
import { AppHeader } from './ui/AppHeader';
import { LoadingState } from './ui/states';
import { useMyTrades, type TradeRow, type TradeRowState } from '../hooks/useMyTrades';
import { TradeExpandPeek } from './TradeExpandPeek';
import { useWants } from '../hooks/useWants';
import { useAvailable } from '../hooks/useAvailable';
import { useGuildMemberships, type GuildMembershipSummary } from '../hooks/useGuildMemberships';
import { useFavorites, type Favorite } from '../hooks/useFavorites';
import { useCardIndexContext } from '../contexts/CardIndexContext';
import { useNavigation } from '../contexts/NavigationContext';
import { cardImageUrl } from '../services/priceService';
import { extractBaseName } from '../variants';
import type { CardVariant } from '../types';
import type { WantsItem, AvailableItem } from '../persistence/schemas';

interface HomeViewProps {
  auth: AuthApi;
}

/**
 * Home — dashboard layout.
 *
 * Four parallel "my" modules in a 2×2 grid, each owning a surface in
 * the IA:
 *
 *   Row 1: 💱 My Trades        | 👥 My Communities
 *   Row 2: ⭐ Your Wishlist    | 📘 Your Binder
 *
 * Plus a pinned ⏰ "Needs your response" callout above the grid when
 * the viewer has open received proposals.
 *
 * Layout history:
 *   - UX-A1 split the combined ListsModule into Wishlist + Binder as
 *     first-class modules (they're load-bearing, not sidebar chrome).
 *   - UX-A4 initially deleted CommunitiesModule entirely, then walked
 *     back: the full module was too loud, but removing it left a blank
 *     quadrant and buried enrolled servers behind a hamburger menu.
 *     Compact module reinstated as row-1 peer to Trades.
 *   - StoresModule (LGS placeholder) removed in the same pass — it was
 *     reserving real estate for a Phase 4 feature that'll have its own
 *     surface when it ships; no need to dim the dashboard with it today.
 *
 * Each row is its own grid so heights align per row independently —
 * Trades/Communities don't have to match Wishlist/Binder in height.
 * Mobile collapses to a single column in priority order.
 */
export function HomeView({ auth }: HomeViewProps) {
  const { user } = auth;
  const nav = useNavigation();
  // Local shorthands for readability — these wrap the `nav` primitive
  // into the method-per-action shape the view body already expects.
  // The underlying `nav.toX()` calls handle pushState + intent sync +
  // viewMode flip in one place.
  const onOpenTrade = nav.toTradeDetail;
  const onOpenTradesHistory = nav.toTradesHistory;
  const onBuildTrade = nav.toBuildTrade;
  const onOpenProfile = nav.toProfile;
  // `useMyTrades` is the unified view layer — merges proposals +
  // sessions into one TradeRow stream. The older `useTradesList` is
  // still consulted for the `needsResponse` callout (which already
  // had overflow/highlight chrome tuned to the proposal shape) but
  // everything inside the My Trades module reads from `myTrades`.
  const myTrades = useMyTrades();
  const wants = useWants();
  const available = useAvailable();
  const guilds = useGuildMemberships();
  // Only surface guilds the viewer is actually enrolled in. `enrollable`
  // is "bot is installed here AND the viewer is in the server"; the
  // `enrolled` flag is the opt-in toggle from Settings → Servers. Home
  // is a "my stuff" view, so unenrolled guilds stay hidden.
  const enrolledGuilds = useMemo(
    () => guilds.enrollable.filter(g => g.enrolled),
    [guilds.enrollable],
  );
  // Explicit trading-partner bookmarks. Independent of community
  // enrollment — lets users pin Discord friends who aren't in any
  // bot-enabled server. Signed-in only; the server endpoint 401s
  // for ghosts, so we gate the fetch here and skip for anonymous.
  const favorites = useFavorites(!!user && !user.isAnonymous);
  // CardIndexContext keeps the byFamily index globally synced — no
  // need for this view to re-trigger `loadAllSets`, the PriceData
  // provider handles that once at app mount. The Lists drawer is a
  // trade-builder-local affordance now, so Home doesn't reach into
  // DrawerContext — the wishlist/binder modules route to their own
  // dedicated views via `nav.toWishlist()` / `nav.toBinder()`.
  const { byFamily, byProductId } = useCardIndexContext();

  // `myTrades` already derives `needsResponse` + `counts` across the
  // unified proposal + session stream, so we don't redo that work here.
  const { needsResponse } = myTrades;
  const tradeCounts = myTrades.counts;

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      {/* Home is the root view for signed-in users — no breadcrumbs,
          AppHeader's logo + NavMenu + AccountMenu anchor the page.
          The Lists drawer lives at App root now, so we just toggle the
          shared open-state via DrawerContext rather than rendering our
          own <ListsDrawer> instance. */}
      <AppHeader auth={auth} />

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-4 max-w-5xl mx-auto w-full flex flex-col gap-6">
        {/* GreetingRow renders unconditionally so the History + New
            trade buttons are clickable on first paint, even before
            `/api/auth/me` resolves. The user field can be null while
            auth is in flight — the row shows a skeleton avatar +
            "Welcome back" without a username, and the action buttons
            don't depend on user state at all (toBuildTrade /
            toTradesHistory just push view-mode state). The avatar
            click target is disabled until the user lands so it
            doesn't open `/u/null` while loading. */}
        <GreetingRow
          user={user}
          onOpenProfile={onOpenProfile}
          onBuildTrade={onBuildTrade}
          onOpenTradesHistory={onOpenTradesHistory}
        />

        {/* Needs-response callout is full-width above the grid so it
            reads as "everything else waits — deal with this first." */}
        {needsResponse.length > 0 && (
          <NeedsResponseCallout
            rows={needsResponse}
            onOpenTrade={onOpenTrade}
            onOpenTradesHistory={onOpenTradesHistory}
          />
        )}

        {/* Desktop: two explicit 2-column rows so each row's columns
            align in height independently. Row 1 is "active surfaces"
            (what's happening + who's around); row 2 is "inventory"
            (what I want + what I have). Mobile collapses to a single
            column in source order: trades → communities → wishlist →
            binder. Lists used to be ONE combined module behind a
            drawer — promoted to two first-class modules (UX-A1) so
            "these are my cards" reads as load-bearing for the trading
            loop, not a sidebar affordance. CommunitiesModule was
            deleted in UX-A4 and then reinstated in the walk-back: the
            original module was too loud but removing it left a blank
            quadrant and buried enrolled servers behind the hamburger
            menu. The reinstated version is a peer module (not a
            sidebar widget) with a tighter member-count focus. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
          <TradesModule
            status={myTrades.status}
            counts={tradeCounts}
            rows={myTrades.rows}
            onOpenTrade={onOpenTrade}
            onOpenTradesHistory={onOpenTradesHistory}
            onBuildTrade={onBuildTrade}
          />
          <CommunitiesModule
            guilds={enrolledGuilds}
            status={guilds.status}
            onOpenCommunity={(guildId) => nav.toCommunity(guildId ? { guildId } : undefined)}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
          <WishlistModule
            wants={wants.items}
            cardByFamily={byFamily}
            onEditWishlist={nav.toWishlist}
          />
          <BinderModule
            available={available.items}
            cardByProductId={byProductId}
            onEditBinder={nav.toBinder}
          />
        </div>

        {/* Trading partners — explicit bookmarks of people you want
            to trade with, independent of community enrollment. Closes
            the gap for Discord friends in no shared bot-enabled server;
            complements Communities (server-scoped) with a user-scoped
            list. Row-3 placement below the inventory grid so it reads
            as "once you know what you have/want, here's who to trade
            with." */}
        <PartnersModule
          favorites={favorites.favorites}
          status={favorites.status}
          onStartTradeWith={(handle) => nav.toStartTradeFrom(handle)}
          onOpenProfile={onOpenProfile}
        />
      </main>
    </div>
  );
}

// --- Greeting / identity ---------------------------------------------------

function GreetingRow({
  user,
  onOpenProfile,
  onBuildTrade,
  onOpenTradesHistory,
}: {
  user: { handle: string; username: string; avatarUrl: string | null } | null;
  onOpenProfile: (handle: string) => void;
  onBuildTrade: () => void;
  onOpenTradesHistory: () => void;
}) {
  const displayName = user
    ? (user.username && user.username !== user.handle ? user.username : `@${user.handle}`)
    : null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Avatar is a button when the user is loaded (clicks through to
          their public profile); a static placeholder while auth is
          still resolving so we don't open `/u/null`. The dimensions
          are identical so the row doesn't shift on auth resolution. */}
      {user ? (
        <button
          type="button"
          onClick={() => onOpenProfile(user.handle)}
          aria-label="Open your public profile"
          className="shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-gold/60"
        >
          <Avatar avatarUrl={user.avatarUrl} name={user.username || user.handle} />
        </button>
      ) : (
        <span aria-hidden className="shrink-0">
          <Avatar avatarUrl={null} name="?" />
        </span>
      )}
      <div className="min-w-0 mr-auto">
        <div className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">
          Welcome back
        </div>
        <div className="text-lg font-semibold text-gray-100 truncate">
          {displayName ?? (
            // Skeleton placeholder — same height as the loaded label
            // so the layout doesn't jump when the username arrives.
            <span aria-hidden className="inline-block w-32 h-4 my-0.5 rounded bg-space-700/60 animate-pulse" />
          )}
        </div>
      </div>
      {/* History + New trade are unconditional. They don't depend on
          user identity — they're just nav.toX() pushes — and being
          clickable on first paint is the whole point: a user with a
          slow `/api/auth/me` response shouldn't have to wait to start
          a trade. Tapping "+ New trade" before auth resolves works
          fine; the trade builder itself doesn't gate on user either. */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onOpenTradesHistory}
          className="flex items-center justify-center gap-1.5 px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-sm font-medium text-gray-300 hover:text-gold transition-colors"
        >
          History
        </button>
        <button
          type="button"
          onClick={onBuildTrade}
          className="flex items-center justify-center gap-1.5 px-4 h-9 rounded-lg bg-gold text-space-900 font-bold text-sm hover:bg-gold-bright transition-colors"
        >
          <PlusIcon className="w-4 h-4" />
          New trade
        </button>
      </div>
    </div>
  );
}

// --- ⏰ Needs your response callout ----------------------------------------

// Cap on the Home screen so a user with dozens of pending proposals
// doesn't get an endless wall — they see the N freshest and drop into
// the full Trades history for the rest.
const HOME_PROPOSAL_CAP = 5;

function NeedsResponseCallout({
  rows,
  onOpenTrade,
  onOpenTradesHistory,
}: {
  rows: TradeRow[];
  onOpenTrade: (tradeId: string) => void;
  onOpenTradesHistory: () => void;
}) {
  const visible = rows.slice(0, HOME_PROPOSAL_CAP);
  const overflow = rows.length - visible.length;
  // Single row expanded at a time — collapses the previous peek when a
  // new one is clicked, avoiding multiple card grids competing for the
  // viewport at once.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <section
      aria-labelledby="needs-response-heading"
      // Slight gold wash + gold left border so the callout reads as
      // "attention required" without being alarming.
      className="rounded-xl border border-gold/40 bg-gold/8 p-4"
    >
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h2 id="needs-response-heading" className="flex items-center gap-2 text-sm font-bold text-gray-100">
          <AlarmClock aria-hidden className="w-4 h-4" />
          <span>Needs your response</span>
          <span className="text-xs tabular-nums text-gold font-bold">{rows.length}</span>
        </h2>
      </div>
      <ul className="flex flex-col gap-1.5">
        {visible.map(row => {
          const expanded = expandedId === row.id;
          return (
            <li key={`${row.kind}-${row.id}`}>
              <TradeListRow
                row={row}
                onClick={() => setExpandedId(expanded ? null : row.id)}
                expanded={expanded}
                peek={
                  row.kind === 'proposal' ? (
                    <TradeExpandPeek
                      proposalId={row.id}
                      onOpenDetail={() => onOpenTrade(row.id)}
                    />
                  ) : (
                    <SessionPeek row={row} />
                  )
                }
              />
            </li>
          );
        })}
      </ul>
      {overflow > 0 && (
        <button
          type="button"
          onClick={onOpenTradesHistory}
          className="mt-2 w-full flex items-center justify-center gap-1 px-4 py-2 rounded-lg bg-space-800/40 border border-space-700 hover:border-gold/40 hover:bg-space-800/60 text-xs font-medium text-gray-400 hover:text-gold transition-colors"
        >
          See all {rows.length} pending →
        </button>
      )}
    </section>
  );
}

// --- 💱 My Trades module ---------------------------------------------------

function TradesModule({
  status,
  counts,
  rows,
  onOpenTrade,
  onOpenTradesHistory,
  onBuildTrade,
}: {
  status: 'loading' | 'ready' | 'error';
  counts: { incoming: number; outgoing: number; resolved: number; activeSessions: number };
  rows: TradeRow[];
  onOpenTrade: (tradeId: string) => void;
  onOpenTradesHistory: () => void;
  onBuildTrade: () => void;
}) {
  const hasAny = rows.length > 0;
  // Mobile caps at 3 rows; desktop at 5. Past that, the "View
  // history" link in the header is the overflow.
  const MOBILE_CAP = 3;
  const DESKTOP_CAP = 5;
  const visible = rows.slice(0, DESKTOP_CAP);
  // Single expanded id across the unified list — opening one row
  // collapses any other.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <ModuleSection
      icon={<ArrowLeftRight aria-hidden className="w-4 h-4" />}
      label="My Trades"
      headingId="my-trades-heading"
      action={
        <button
          type="button"
          onClick={onOpenTradesHistory}
          className="text-[11px] text-gray-500 hover:text-gold font-medium transition-colors"
        >
          View history →
        </button>
      }
    >
      <div className="text-[12px] text-gray-400 tabular-nums mb-3 flex flex-wrap gap-x-3 gap-y-1">
        {counts.activeSessions > 0 && (
          <span>
            <span className="text-cyan-300 font-semibold">{counts.activeSessions}</span>
            {' shared'}
          </span>
        )}
        <span>
          <span className="text-gray-200 font-semibold">{counts.incoming}</span>
          {' awaiting'}
        </span>
        <span>
          <span className="text-gray-200 font-semibold">{counts.outgoing}</span>
          {' pitched'}
        </span>
        <span>
          <span className="text-gray-200 font-semibold">{counts.resolved}</span>
          {' resolved'}
        </span>
      </div>

      {status === 'loading' && <LoadingState label="Loading trades…" />}
      {status !== 'loading' && !hasAny && (
        <div className="rounded-lg bg-space-800/30 border border-space-700 px-4 py-3 text-xs text-gray-500 leading-relaxed">
          No trades yet.{' '}
          <button
            type="button"
            onClick={onBuildTrade}
            className="text-gold hover:text-gold-bright underline font-semibold"
          >
            Start one
          </button>
          {' — build alone, invite someone to trade together, or share a QR at the shop.'}
        </div>
      )}
      {hasAny && (
        <ul className="flex flex-col gap-1.5">
          {visible.map((row, idx) => {
            const expanded = expandedId === row.id;
            const onToggle = () => setExpandedId(expanded ? null : row.id);
            return (
              <li
                key={`${row.kind}-${row.id}`}
                className={idx >= MOBILE_CAP ? 'hidden lg:list-item' : undefined}
              >
                <TradeListRow
                  row={row}
                  onClick={onToggle}
                  expanded={expanded}
                  peek={
                    row.kind === 'proposal' ? (
                      <TradeExpandPeek
                        proposalId={row.id}
                        onOpenDetail={() => onOpenTrade(row.id)}
                      />
                    ) : (
                      <SessionPeek row={row} />
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </ModuleSection>
  );
}

/**
 * Compact peek for a session row — no fetch, just metadata + a
 * primary action. Session cards would require a separate fetch to
 * re-render here; we defer the richer peek to a later sliver and
 * let users click through to the canvas for the full view.
 */
function SessionPeek({ row }: { row: TradeRow }) {
  const label = row.counterpart
    ? `@${row.counterpart.handle}${row.counterpart.isAnonymous ? ' (guest)' : ''}`
    : 'Waiting on counterpart';
  return (
    <div className="border-t border-space-700/60 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-gray-400">
          {row.openSlot
            ? 'Open invitation — share the QR or link from inside.'
            : `Shared trade with ${label} · ${row.yourCount} offered · ${row.theirCount} received`}
        </div>
        <a
          href={`/s/${encodeURIComponent(row.id)}`}
          className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-cyan-300 hover:text-cyan-200 transition-colors"
        >
          Open session
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </a>
      </div>
    </div>
  );
}

/**
 * Unified list row for My Trades — renders a proposal OR a session
 * with the same chrome. State badge + counterpart identity + card
 * counts + timestamp. Expand reveals the kind-appropriate peek (full
 * card images for proposals, metadata for sessions).
 */
function TradeListRow({
  row,
  onClick,
  expanded,
  peek,
}: {
  row: TradeRow;
  onClick: () => void;
  expanded?: boolean;
  peek?: React.ReactNode;
}) {
  const counterpartLabel = row.counterpart
    ? `@${row.counterpart.handle}${row.counterpart.isAnonymous ? ' (guest)' : ''}`
    : row.openSlot ? 'Waiting for counterpart' : 'Unknown trader';
  const when = timeAgoShort(row.lastActivityAt);
  const highlight = row.state === 'awaiting';
  const containerClass = expanded
    ? (highlight ? 'bg-gold/12 border-gold/50' : 'bg-space-800/70 border-gold/40')
    : highlight
      ? 'bg-gold/8 border-gold/40 hover:border-gold/60'
      : 'bg-space-800/40 border-space-700 hover:border-gold/30';
  return (
    <div className={`rounded-lg border transition-colors ${containerClass}`}>
      <button
        type="button"
        onClick={onClick}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} trade with ${counterpartLabel}`}
        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
          highlight ? 'hover:bg-gold/12' : 'hover:bg-white/[0.02] active:bg-white/[0.04]'
        }`}
      >
        <Avatar
          avatarUrl={row.counterpart?.avatarUrl ?? null}
          name={row.counterpart?.username || row.counterpart?.handle || '?'}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
            <span className="text-sm font-medium text-gray-100 truncate">
              {counterpartLabel}
            </span>
            <StateBadge state={row.state} />
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5 truncate">
            {row.yourCount} offered · {row.theirCount} received · {when}
            {row.kind === 'proposal' && row.topCard && ` · ${row.topCard.name}`}
          </div>
        </div>
        <ChevronIcon
          className={`w-4 h-4 text-gray-500 shrink-0 transition-transform ${
            expanded ? 'rotate-0' : '-rotate-90'
          }`}
        />
      </button>
      {expanded && peek}
    </div>
  );
}

/**
 * State badge — single source of truth for how each `TradeRowState`
 * renders. Colors follow the app palette: cyan=shared (active, in
 * flight), gold=attention/pending, emerald=terminal-positive,
 * red=terminal-negative, neutral=everything else. Short labels
 * because they live on a crowded row.
 */
function StateBadge({ state }: { state: TradeRowState }) {
  const { label, tone } = stateBadgeSpec(state);
  const toneClass = BADGE_TONES[tone];
  return (
    <span className={`shrink-0 px-1.5 h-[18px] inline-flex items-center rounded text-[9px] tracking-wider uppercase font-bold ${toneClass}`}>
      {label}
    </span>
  );
}

const BADGE_TONES: Record<string, string> = {
  cyan:    'bg-cyan-900/40 border border-cyan-500/40 text-cyan-200',
  gold:    'bg-gold/15 border border-gold/40 text-gold',
  emerald: 'bg-emerald-900/40 border border-emerald-500/40 text-emerald-300',
  red:     'bg-red-900/40 border border-red-500/40 text-red-300',
  neutral: 'bg-space-700/60 border border-space-600 text-gray-400',
  purple:  'bg-purple-900/40 border border-purple-500/40 text-purple-300',
};

function stateBadgeSpec(state: TradeRowState): { label: string; tone: keyof typeof BADGE_TONES } {
  switch (state) {
    case 'shared':          return { label: 'Shared',   tone: 'cyan' };
    case 'shared-waiting':  return { label: 'Invite',   tone: 'cyan' };
    case 'awaiting':        return { label: 'Awaiting', tone: 'gold' };
    case 'pitched':         return { label: 'Pitched',  tone: 'gold' };
    case 'settled':         return { label: 'Settled',  tone: 'emerald' };
    case 'declined':        return { label: 'Declined', tone: 'red' };
    case 'cancelled':       return { label: 'Cancelled', tone: 'neutral' };
    case 'expired':         return { label: 'Expired',  tone: 'neutral' };
    case 'countered':       return { label: 'Countered', tone: 'purple' };
  }
}

// --- ⭐ Your wishlist module -----------------------------------------------

/**
 * Cap on how many rows each of the two list modules surface on Home
 * before deferring to the drawer. Tuned for density against the
 * rest of the dashboard — higher than the earlier ListsModule's
 * priorities-only preview because these modules are the primary
 * surface for inventory state now, not a drawer-affordance widget.
 */
const LIST_MODULE_CAP = 5;

function WishlistModule({
  wants,
  cardByFamily,
  onEditWishlist,
}: {
  wants: WantsItem[];
  cardByFamily: Map<string, CardVariant>;
  onEditWishlist: () => void;
}) {
  const priorityCount = useMemo(() => wants.filter(w => w.isPriority).length, [wants]);
  // Priorities pinned first, then everything else by newest-added.
  // The existing drawer sort is identical; mirroring here keeps the
  // "top of the wishlist" concept consistent across both surfaces.
  const sorted = useMemo(() => {
    return [...wants].sort((a, b) => {
      const pa = a.isPriority ? 1 : 0;
      const pb = b.isPriority ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return b.addedAt - a.addedAt;
    });
  }, [wants]);
  const visible = sorted.slice(0, LIST_MODULE_CAP);

  return (
    <ModuleSection
      icon={<Star aria-hidden className="w-4 h-4" />}
      label="Your wishlist"
      headingId="your-wishlist-heading"
      action={
        <button
          type="button"
          onClick={onEditWishlist}
          className="text-[11px] text-gray-500 hover:text-gold font-medium transition-colors"
        >
          Edit wishlist →
        </button>
      }
    >
      <div className="text-[12px] text-gray-400 tabular-nums mb-3">
        <span className="text-gray-200 font-semibold">{wants.length}</span>
        {wants.length === 1 ? ' card' : ' cards'}
        {priorityCount > 0 && (
          <>
            {' · '}
            <span className="text-gold font-semibold">{priorityCount}</span>
            {' priority'}
          </>
        )}
      </div>

      {wants.length === 0 && (
        <EmptyListState
          onEdit={onEditWishlist}
          linkText="Add cards you want"
          suffix=" — others with matching cards can find you in matchmaking."
        />
      )}
      {visible.length > 0 && (
        <ul className="flex flex-col gap-1">
          {visible.map((w, idx) => {
            const card = cardByFamily.get(w.familyId);
            return (
              <li
                key={w.id}
                // Mobile caps at 3 rows so the module stays compact;
                // desktop shows the full 5 since the vertical real
                // estate is there.
                className={idx >= 3 ? 'hidden lg:list-item' : undefined}
              >
                <ListItemRow
                  productId={card?.productId ?? null}
                  name={card?.name ?? 'Card'}
                  qty={w.qty}
                  isPriority={w.isPriority}
                  onClick={onEditWishlist}
                />
              </li>
            );
          })}
        </ul>
      )}
    </ModuleSection>
  );
}

// --- 📘 Your binder module ------------------------------------------------

function BinderModule({
  available,
  cardByProductId,
  onEditBinder,
}: {
  available: AvailableItem[];
  cardByProductId: Map<string, CardVariant>;
  onEditBinder: () => void;
}) {
  // Binder has no priority concept — newest additions float to the top
  // (most likely to be what the viewer is actively thinking about;
  // a week-old add is background inventory).
  const sorted = useMemo(() => {
    return [...available].sort((a, b) => b.addedAt - a.addedAt);
  }, [available]);
  const visible = sorted.slice(0, LIST_MODULE_CAP);

  return (
    <ModuleSection
      icon={<BookOpen aria-hidden className="w-4 h-4" />}
      label="Your trade binder"
      headingId="your-binder-heading"
      action={
        <button
          type="button"
          onClick={onEditBinder}
          className="text-[11px] text-gray-500 hover:text-gold font-medium transition-colors"
        >
          Edit trade binder →
        </button>
      }
    >
      <div className="text-[12px] text-gray-400 tabular-nums mb-3">
        <span className="text-gray-200 font-semibold">{available.length}</span>
        {available.length === 1 ? ' card available' : ' cards available'}
      </div>

      {available.length === 0 && (
        <EmptyListState
          onEdit={onEditBinder}
          linkText="Add cards you have"
          suffix=" — they surface in other traders' searches and in matchmaking suggestions."
        />
      )}
      {visible.length > 0 && (
        <ul className="flex flex-col gap-1">
          {visible.map((a, idx) => {
            const card = cardByProductId.get(a.productId);
            return (
              <li
                key={a.id}
                className={idx >= 3 ? 'hidden lg:list-item' : undefined}
              >
                <ListItemRow
                  productId={a.productId}
                  name={card?.name ?? 'Card'}
                  qty={a.qty}
                  onClick={onEditBinder}
                />
              </li>
            );
          })}
        </ul>
      )}
    </ModuleSection>
  );
}

// Shared row for both list modules — thumbnail + name + qty.
// Tapping the row routes back into the drawer on the appropriate
// tab so the "edit" affordance is the whole row, not just the label.
function ListItemRow({
  productId,
  name,
  qty,
  isPriority = false,
  onClick,
}: {
  productId: string | null;
  name: string;
  qty: number;
  isPriority?: boolean;
  onClick: () => void;
}) {
  const imgUrl = productId ? cardImageUrl(productId, 'sm') : null;
  const baseName = extractBaseName(name);
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-2.5 py-1.5 rounded-lg bg-space-800/30 border border-space-700 hover:border-gold/30 hover:bg-space-800/50 transition-colors text-left"
    >
      <span
        aria-hidden
        className="shrink-0 w-8 h-11 rounded overflow-hidden bg-space-900 border border-space-700"
      >
        {imgUrl ? (
          <img src={imgUrl} alt="" loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <span className="w-full h-full flex items-center justify-center text-gray-600 text-xs">?</span>
        )}
      </span>
      <span className="flex-1 min-w-0 flex items-center gap-1.5">
        {isPriority && (
          <span aria-hidden className="text-gold text-sm leading-none shrink-0">★</span>
        )}
        <span className="text-[12px] text-gray-200 truncate">{baseName}</span>
      </span>
      <span className="text-[11px] text-gray-500 tabular-nums shrink-0">×{qty}</span>
    </button>
  );
}

function EmptyListState({
  onEdit,
  linkText,
  suffix,
}: {
  onEdit: () => void;
  linkText: string;
  suffix: string;
}) {
  return (
    <div className="rounded-lg bg-space-800/30 border border-space-700 px-4 py-3 text-xs text-gray-500 leading-relaxed">
      <button
        type="button"
        onClick={onEdit}
        className="text-gold hover:text-gold-bright underline font-semibold"
      >
        {linkText}
      </button>
      {suffix}
    </div>
  );
}

// --- 👥 My Communities module ---------------------------------------------

// Cap enrolled guilds on Home so a user in dozens of servers doesn't
// get a wall of rows — they see the N largest and drop into the full
// community view for the rest.
const COMMUNITY_MODULE_CAP = 5;

function CommunitiesModule({
  guilds,
  status,
  onOpenCommunity,
}: {
  guilds: GuildMembershipSummary[];
  status: 'loading' | 'ready' | 'saving' | 'error';
  onOpenCommunity: (guildId?: string) => void;
}) {
  // Sort by trader count descending so the biggest community (most
  // likely to yield matches) floats to the top.
  const sorted = useMemo(() => {
    return [...guilds].sort((a, b) => b.memberCount - a.memberCount);
  }, [guilds]);
  const visible = sorted.slice(0, COMMUNITY_MODULE_CAP);
  const totalTraders = useMemo(
    () => guilds.reduce((sum, g) => sum + g.memberCount, 0),
    [guilds],
  );

  return (
    <ModuleSection
      icon={<Users aria-hidden className="w-4 h-4" />}
      label="My Communities"
      headingId="my-communities-heading"
      action={
        <button
          type="button"
          onClick={() => onOpenCommunity()}
          className="text-[11px] text-gray-500 hover:text-gold font-medium transition-colors"
        >
          Browse all →
        </button>
      }
    >
      <div className="text-[12px] text-gray-400 tabular-nums mb-3 flex flex-wrap gap-x-3 gap-y-1">
        <span>
          <span className="text-gray-200 font-semibold">{guilds.length}</span>
          {guilds.length === 1 ? ' server' : ' servers'}
        </span>
        {totalTraders > 0 && (
          <span>
            <span className="text-gray-200 font-semibold">{totalTraders}</span>
            {totalTraders === 1 ? ' trader' : ' traders'}
          </span>
        )}
      </div>

      {status === 'loading' && guilds.length === 0 && (
        <LoadingState label="Loading communities…" />
      )}
      {status !== 'loading' && guilds.length === 0 && (
        <div className="rounded-lg bg-space-800/30 border border-space-700 px-4 py-3 text-xs text-gray-500 leading-relaxed">
          <button
            type="button"
            onClick={() => onOpenCommunity()}
            className="text-gold hover:text-gold-bright underline font-semibold"
          >
            Find your communities
          </button>
          {' — enroll a Discord server where the SWUTrade bot lives to trade with its members.'}
        </div>
      )}
      {visible.length > 0 && (
        <ul className="flex flex-col gap-1">
          {visible.map((g, idx) => (
            <li
              key={g.guildId}
              className={idx >= 3 ? 'hidden lg:list-item' : undefined}
            >
              <GuildRow guild={g} onClick={() => onOpenCommunity(g.guildId)} />
            </li>
          ))}
        </ul>
      )}
    </ModuleSection>
  );
}

function GuildRow({
  guild,
  onClick,
}: {
  guild: GuildMembershipSummary;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-2.5 py-1.5 rounded-lg bg-space-800/30 border border-space-700 hover:border-gold/30 hover:bg-space-800/50 transition-colors text-left"
    >
      <GuildAvatar
        icon={guild.guildIcon}
        name={guild.guildName}
        guildId={guild.guildId}
      />
      <span className="flex-1 min-w-0 text-[12px] text-gray-200 truncate">
        {guild.guildName}
      </span>
      <span className="text-[11px] text-gray-500 tabular-nums shrink-0">
        {guild.memberCount === 1 ? '1 trader' : `${guild.memberCount} traders`}
      </span>
    </button>
  );
}

function GuildAvatar({
  icon,
  name,
  guildId,
}: {
  icon: string | null;
  name: string;
  guildId: string;
}) {
  if (icon) {
    const iconUrl = `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=64`;
    return (
      <img
        src={iconUrl}
        alt=""
        loading="lazy"
        className="w-8 h-8 rounded-md shrink-0 bg-space-900"
      />
    );
  }
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className="w-8 h-8 rounded-md bg-space-700 text-gold font-bold flex items-center justify-center shrink-0 text-sm"
    >
      {initial}
    </span>
  );
}

// --- 🤝 Trading partners module -------------------------------------------

// Cap the row count so a heavy user doesn't get a wall. Favorites
// grow linearly with every star-toggle; past the cap the module
// shows a "+ N more" hint and the rest live on a future partners
// page (not built yet).
const PARTNERS_MODULE_CAP = 6;

function PartnersModule({
  favorites,
  status,
  onStartTradeWith,
  onOpenProfile,
}: {
  favorites: Favorite[];
  status: 'loading' | 'ready' | 'error';
  onStartTradeWith: (handle: string) => void;
  onOpenProfile: (handle: string) => void;
}) {
  const visible = favorites.slice(0, PARTNERS_MODULE_CAP);
  const overflow = favorites.length - visible.length;

  return (
    <ModuleSection
      icon={<Handshake aria-hidden className="w-4 h-4" />}
      label="Your trading partners"
      headingId="your-trading-partners-heading"
    >
      {/* Count strip — matches the shape other modules use (N servers,
          N cards available) so the row reads consistently. Hidden when
          empty so the empty state takes center stage. */}
      {favorites.length > 0 && (
        <div className="text-[12px] text-gray-400 tabular-nums mb-3">
          <span className="text-gray-200 font-semibold">{favorites.length}</span>
          {favorites.length === 1 ? ' partner' : ' partners'}
        </div>
      )}

      {status === 'loading' && favorites.length === 0 && (
        <LoadingState label="Loading partners…" />
      )}
      {status !== 'loading' && favorites.length === 0 && (
        <div className="rounded-lg bg-space-800/30 border border-space-700 px-4 py-3 text-xs text-gray-500 leading-relaxed">
          Bookmark trading partners from their profile for one-tap access. Independent of Discord communities — great for friends who trade outside a shared server.
        </div>
      )}

      {visible.length > 0 && (
        <ul className="flex flex-col gap-1">
          {visible.map((fav, idx) => (
            <li
              key={fav.userId}
              className={idx >= 3 ? 'hidden sm:list-item' : undefined}
            >
              <PartnerRow
                favorite={fav}
                onStartTrade={() => onStartTradeWith(fav.handle)}
                onOpenProfile={() => onOpenProfile(fav.handle)}
              />
            </li>
          ))}
        </ul>
      )}

      {overflow > 0 && (
        <div className="mt-2 text-[11px] text-gray-500 tabular-nums text-center">
          +{overflow} more
        </div>
      )}
    </ModuleSection>
  );
}

function PartnerRow({
  favorite,
  onStartTrade,
  onOpenProfile,
}: {
  favorite: Favorite;
  onStartTrade: () => void;
  onOpenProfile: () => void;
}) {
  // Two primary actions per row: tap the identity area → their
  // profile (review before trading); tap the gold "Trade" button →
  // straight into the composer with them pre-filled as counterpart.
  // Split on tap targets so a mobile user can still open the profile
  // without misfiring the one-click-to-trade path.
  return (
    <div className="w-full flex items-center gap-3 px-2.5 py-1.5 rounded-lg bg-space-800/30 border border-space-700 hover:border-gold/30 hover:bg-space-800/50 transition-colors">
      <button
        type="button"
        onClick={onOpenProfile}
        aria-label={`Open @${favorite.handle}'s profile`}
        className="flex items-center gap-3 flex-1 min-w-0 text-left"
      >
        <Avatar avatarUrl={favorite.avatarUrl} name={favorite.username || favorite.handle} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-100 truncate">
            {favorite.username || `@${favorite.handle}`}
          </div>
          <div className="text-[11px] text-gray-500 truncate">
            @{favorite.handle}
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={onStartTrade}
        className="shrink-0 px-2.5 h-7 rounded-md bg-gold/15 border border-gold/40 hover:bg-gold/25 hover:border-gold/60 text-[11px] font-bold text-gold transition-colors"
      >
        Trade
      </button>
    </div>
  );
}

// --- Shared module chrome --------------------------------------------------

function ModuleSection({
  icon,
  label,
  headingId,
  action,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  headingId: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={headingId}
      // Each module sits in its own subtle panel. Gives the dashboard
      // a consistent "these are four parallel things" visual rhythm
      // without heavy chrome — the space-800/20 wash is darker than
      // the page ground but lighter than the interactive rows within.
      className="rounded-xl border border-space-700 bg-space-800/20 p-4"
    >
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2
          id={headingId}
          className="flex items-center gap-2 text-[11px] tracking-[0.18em] uppercase text-gray-400 font-bold"
        >
          {icon}
          <span>{label}</span>
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// --- Rows / shared UI ------------------------------------------------------

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function Avatar({ avatarUrl, name }: { avatarUrl: string | null; name: string }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="w-10 h-10 rounded-full shrink-0" />;
  }
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className="w-10 h-10 rounded-full bg-space-700 text-gold font-bold flex items-center justify-center shrink-0 text-sm"
    >
      {initial}
    </span>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <path d="M10 4v12M4 10h12" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
