import { useMemo, useState } from 'react';
import {
  BookOpen,
  Handshake,
  Inbox,
  Megaphone,
  Plus,
  Search,
  Star,
  Users,
} from 'lucide-react';
import type { AuthApi } from '../hooks/useAuth';
import { AppHeader } from './ui/AppHeader';
import { LoadingState } from './ui/states';
import { relativeTime } from '../utils/relativeTime';
import { useMyTrades, type TradeRow, type TradeRowState } from '../hooks/useMyTrades';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
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
  // Wants + available are owned by App.tsx so useServerSync's writeback
  // lands on a single React-state instance shared across views. An
  // earlier version of HomeView called useWants()/useAvailable() itself,
  // which created a second state instance: localStorage stayed in sync,
  // but HomeView's React state held the mount-time snapshot and never
  // reflected the post-sign-in server pull. Result on a freshly signed-
  // in older device: home dashboard showed stale wants while the
  // dedicated wishlist view (which already received the prop) showed
  // the correct server-side list.
  wants: WantsApi;
  available: AvailableApi;
}

/**
 * Home v2 — vertical-zone layout. Four zones top-to-bottom, each
 * with a clear purpose:
 *
 *   Zone 1 — ⚡ Quick actions row.
 *            Always visible, top of page. Three peer tiles today
 *            (Browse cards, New trade, Post a signal). Designed to
 *            grow — drop a new ActionTile in and the responsive
 *            grid wraps.
 *   Zone 2 — 📥 Inbox.
 *            In-flight trades + sessions surfaced as ambient
 *            informational ("here's what's happening") rather than
 *            an alarm bell. Hidden entirely when empty. Per-row
 *            state badges (Awaiting / Countered etc.) handle the
 *            "this needs you" highlight without bumping the whole
 *            section into urgent chrome. Phase 2 backlog: real
 *            per-row read/unread state + a dedicated /?inbox=1 page.
 *   Zone 3 — Wishlist + Binder.
 *            Two sibling module cards in a 2-col grid, side-by-side
 *            on desktop, stacked on mobile. No outer section title —
 *            each module's own heading ("Your wishlist", "Your trade
 *            binder") already says what it is, and an outer "Your
 *            Collection" wrapper just duplicated chrome.
 *   Zone 4 — Communities + Partners.
 *            Same shape — modules already say "My Communities" /
 *            "Trading partners" in their own headings, no outer
 *            wrapper needed.
 *
 * Layout history:
 *   - v1 was a 2×2 module grid (Trades / Communities / Wishlist /
 *     Binder) plus a Greeting row + needs-response callout. Modules
 *     stretched to match their tallest sibling's height, leaving
 *     awkward empty wells under shorter ones; terminal-state trade
 *     rows ("declined", "cancelled") flooded the dashboard with
 *     non-actionable chrome.
 *   - v2 (this) drops the greeting row entirely (real estate
 *     premium on mobile; the avatar lives in AppHeader's account
 *     menu), promotes Quick Actions to the top, demotes the trade
 *     activity into a softer Inbox section beneath actions, and
 *     groups the inventory + community modules under section
 *     headings rather than as 2×2 cells. Mobile is a clean
 *     single-column flow.
 */
export function HomeView({ auth, wants, available }: HomeViewProps) {
  const { user } = auth;
  const nav = useNavigation();
  // Local shorthands for readability — these wrap the `nav` primitive
  // into the method-per-action shape the view body already expects.
  // The underlying `nav.toX()` calls handle pushState + intent sync +
  // viewMode flip in one place.
  const onOpenTradesHistory = nav.toTradesHistory;
  const onBuildTrade = nav.toBuildTrade;
  const onOpenProfile = nav.toProfile;
  const myTrades = useMyTrades();
  const guilds = useGuildMemberships();
  // Only surface guilds the viewer is actually enrolled in. `enrollable`
  // is "bot is installed here AND the viewer is in the server"; the
  // `enrolled` flag is the opt-in toggle from Settings → Servers. Home
  // is a "my stuff" view, so unenrolled guilds stay hidden.
  const enrolledGuilds = useMemo(
    () => guilds.enrollable.filter(g => g.enrolled),
    [guilds.enrollable],
  );
  // "Post to a server" affordances are real-account-only (ghosts
  // can't post — Discord identity is required). We deliberately
  // DON'T gate on `enrolledGuilds.length > 0` here, even though a
  // user with zero enrolled servers can't actually post: that gate
  // depends on the /api/me/guilds fetch, which resolves later than
  // auth, and was causing the Post-a-signal tile (and the
  // Post-to-server links inside Wishlist/Binder) to pop in well
  // after the rest of Home rendered. SignalBuilderView already
  // handles the empty-enrolled-server case with a "No enrolled
  // servers" prompt + Settings link, so the user lands somewhere
  // useful either way and the home affordance shows up at the same
  // time as the rest of the page chrome.
  const canPostToServer = !!user && !user.isAnonymous;
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

  // Active-trades filter for the priority strip. Excludes terminal
  // states (settled / declined / cancelled / expired / promoted) AND
  // the bookkeeping-only `promoted` rows whose underlying session
  // surfaces under `shared` separately. The strip is hidden entirely
  // when this is empty — Home v2's principle is "no zero-state
  // chrome on a quiet day."
  const activeTrades = useMemo(
    () => myTrades.rows.filter(r => HOME_ACTIVE_STATES.has(r.state)),
    [myTrades.rows],
  );

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      {/* Home is the root view for signed-in users — no breadcrumbs,
          AppHeader's logo + NavMenu + AccountMenu anchor the page. */}
      <AppHeader auth={auth} />

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-4 max-w-5xl mx-auto w-full flex flex-col gap-6">
        {/* === Zone 1: Quick actions — always visible, top of page
            so the most common workflows (browse a card, start a
            trade, post a signal) are the first thing in reach.
            Designed to grow: drop a new ActionTile in and the
            responsive grid wraps cleanly as more actions land.
            Post-a-signal is real-account-only since signals require
            an enrolled community. */}
        <QuickActionsRow
          onBrowseCards={nav.toCardBrowser}
          onNewTrade={onBuildTrade}
          canPostToServer={canPostToServer}
        />

        {/* === Zone 2: Inbox — in-flight trades surfaced as
            ambient/informational ("here's what's currently
            happening") rather than an alarm bell. Hidden when
            empty. Phase 2 will add real per-row read/unread
            tracking + a dedicated /?inbox=1 page; for now this
            shows all active trades. */}
        {activeTrades.length > 0 && (
          <InboxSection
            rows={activeTrades}
            onOpenTradesHistory={onOpenTradesHistory}
          />
        )}

        {/* === Zone 3: Wishlist + Binder packed into one unified
            card. Conceptually the pair "what I want / what I have"
            — sharing one outer frame reads as a single "your
            inventory" surface rather than two unrelated cards. The
            two halves still render side-by-side on desktop with a
            soft divider; mobile stacks them with a horizontal rule
            between. Each child uses ModuleSection's `flush` mode so
            the existing module headings + content render without
            their own outer chrome. */}
        <section className="rounded-xl border border-space-700 bg-space-800/20 p-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6 lg:divide-x lg:divide-space-700 divide-y lg:divide-y-0 divide-space-700">
            <div className="lg:pr-6 pb-4 lg:pb-0">
              <WishlistModule
                wants={wants.items}
                cardByFamily={byFamily}
                onEditWishlist={nav.toWishlist}
                canPostToServer={canPostToServer}
                flush
              />
            </div>
            <div className="lg:pl-6 pt-4 lg:pt-0">
              <BinderModule
                available={available.items}
                cardByProductId={byProductId}
                onEditBinder={nav.toBinder}
                canPostToServer={canPostToServer}
                flush
              />
            </div>
          </div>
        </section>

        {/* === Zone 4: Communities + Partners. Same shape — modules
            already say "My Communities" / "Trading partners" in
            their own headings, so the outer section title was
            redundant. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <CommunitiesModule
            guilds={enrolledGuilds}
            status={guilds.status}
            onOpenCommunity={(guildId) => nav.toCommunity(guildId ? { guildId } : undefined)}
          />
          <PartnersModule
            favorites={favorites.favorites}
            status={favorites.status}
            onStartTradeWith={(handle) => nav.toStartTradeFrom(handle)}
            onOpenProfile={onOpenProfile}
          />
        </div>
      </main>
    </div>
  );
}

// --- ⚡ Quick actions row -------------------------------------------------

/**
 * Top-of-page action row. Renders one tile per "common thing the
 * viewer might want to do." Designed to grow: drop a new ActionTile
 * into the children list and the responsive grid wraps cleanly. The
 * tile chrome is identical across every action so the row reads as
 * a peer set, not a hierarchy.
 *
 * Today's three:
 *   - Browse cards   — discovery surface (search + price lookup)
 *   - New trade      — kicks off the composer
 *   - Post a signal  — broadcast a wishlist/binder to a community
 *                      (signed-in only; ghosts can't post signals)
 */
function QuickActionsRow({
  onBrowseCards,
  onNewTrade,
  canPostToServer,
}: {
  onBrowseCards: () => void;
  onNewTrade: () => void;
  canPostToServer: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      <ActionTile
        icon={<Search aria-hidden className="w-4 h-4" />}
        label="Browse cards"
        hint="Look up cards and check prices"
        onClick={onBrowseCards}
      />
      <ActionTile
        icon={<Plus aria-hidden className="w-4 h-4" />}
        label="New trade"
        hint="Build a trade solo or with a partner"
        onClick={onNewTrade}
      />
      {canPostToServer && (
        <ActionTile
          icon={<Megaphone aria-hidden className="w-4 h-4" />}
          label="Post a signal"
          hint="Ask for or offer specific cards"
          href="/?signals=new"
        />
      )}
    </div>
  );
}

/**
 * Single action card used by QuickActionsRow. Renders as an `<a>`
 * when given `href` (so middle-click + cmd-click work as expected
 * for nav targets) or a `<button>` for callback-only actions like
 * the trade builder. Same chrome either way.
 */
function ActionTile({
  icon,
  label,
  hint,
  onClick,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick?: () => void;
  href?: string;
}) {
  const cls = 'flex items-center gap-3 px-3 py-2.5 rounded-xl bg-space-800/40 border border-space-700 hover:border-gold/50 hover:bg-space-800/70 transition-colors text-left group';
  const inner = (
    <>
      <span className="shrink-0 w-9 h-9 rounded-lg bg-space-800 border border-space-700 flex items-center justify-center text-gray-400 group-hover:text-gold group-hover:border-gold/40 transition-colors">
        {icon}
      </span>
      <span className="min-w-0 flex flex-col">
        <span className="text-sm font-semibold text-gray-100 group-hover:text-gold transition-colors">{label}</span>
        <span className="text-[11px] text-gray-500 leading-tight mt-0.5 truncate">{hint}</span>
      </span>
    </>
  );
  if (href) {
    return <a href={href} className={cls}>{inner}</a>;
  }
  return <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

// --- 📥 Inbox section -----------------------------------------------------

// Trade states that show up in the inbox. Anything not here (settled,
// declined, cancelled, expired, promoted) is terminal and belongs in
// History, not on the dashboard. Promoted is a special case — the
// underlying session already surfaces under `shared`, so the
// bookkeeping stub would double-render. Hide from inbox.
const HOME_ACTIVE_STATES: ReadonlySet<TradeRowState> = new Set([
  'shared',
  'shared-waiting',
]);

const INBOX_CAP = 5;

/**
 * Zone 2 — the inbox. In-flight trades + sessions surfaced as
 * ambient/informational ("here's what's currently in flight") rather
 * than an alarm-bell. Hidden entirely when empty. Per-row state
 * badges (Awaiting / Countered etc.) handle the "this needs you"
 * highlight without bumping the whole section into urgent chrome.
 *
 * Phase 2 backlog: real per-row read/unread state (server-side, so
 * "read on phone → reflected on laptop") + a dedicated /?inbox=1
 * page that includes resolved items. This Phase 1 version shows all
 * active trades regardless of read state and links overflow to the
 * existing history view.
 */
function InboxSection({
  rows,
  onOpenTradesHistory,
}: {
  rows: TradeRow[];
  onOpenTradesHistory: () => void;
}) {
  const visible = rows.slice(0, INBOX_CAP);
  const overflow = rows.length - visible.length;
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section
      aria-labelledby="inbox-heading"
      className="rounded-xl p-4 border border-space-700 bg-space-800/30"
    >
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h2 id="inbox-heading" className="flex items-center gap-2 text-sm font-bold text-gray-100">
          <Inbox aria-hidden className="w-4 h-4 text-gray-400" />
          <span>Inbox</span>
          <span className="text-xs tabular-nums font-bold text-gray-400">
            {rows.length}
          </span>
        </h2>
        <button
          type="button"
          onClick={onOpenTradesHistory}
          className="text-[11px] text-gray-500 hover:text-gold font-medium transition-colors"
        >
          View all →
        </button>
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
                peek={<SessionPeek row={row} />}
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
          See all {rows.length} →
        </button>
      )}
    </section>
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
  const when = relativeTime(row.lastActivityAt);
  // Highlight the row when the session is waiting on the viewer
  // (B6's server-derived awaitingViewer flag). Gold-attention
  // chrome; the InboxSection's ambient frame stays neutral.
  const highlight = row.awaitingViewer === true;
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
    case 'shared':          return { label: 'Shared',    tone: 'cyan' };
    case 'shared-waiting':  return { label: 'Invite',    tone: 'cyan' };
    case 'settled':         return { label: 'Settled',   tone: 'emerald' };
    case 'cancelled':       return { label: 'Cancelled', tone: 'neutral' };
    case 'expired':         return { label: 'Expired',   tone: 'neutral' };
  }
  // Defensive fallback — exhaustive switch is `never` here today, but
  // a future schema status that lands at runtime before the client
  // union is updated should degrade gracefully rather than
  // error-boundary the dashboard.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return { label: String(state ?? 'Unknown'), tone: 'neutral' };
}

// --- ⭐ Your wishlist module -----------------------------------------------

/**
 * Cap on how many rows each of the two list modules surface on Home
 * before deferring to the drawer. Tuned for density against the
 * rest of the dashboard — higher than the earlier ListsModule's
 * priorities-only preview because these modules are the primary
 * surface for inventory state now, not a drawer-affordance widget.
 */
// 3 visible rows on Home with an explicit "+N more" overflow link
// instead of 5 visible. The dashboard wants a peek at the top of the
// list, not a thumbnail of the whole list — we used to show 5 desktop
// / 3 mobile, but that caused tall modules to dominate the dashboard
// and hide the lower-row Communities/Binder content below the fold.
// Edit-wishlist / Edit-binder is the destination for "see the full
// list"; the overflow link makes that affordance one tap away.
const LIST_MODULE_CAP = 3;

function WishlistModule({
  wants,
  cardByFamily,
  onEditWishlist,
  canPostToServer,
  flush = false,
}: {
  wants: WantsItem[];
  cardByFamily: Map<string, CardVariant>;
  onEditWishlist: () => void;
  /** True when the viewer is signed in (real account) and could
   *  reach the Signal Builder. Gates the "Post to a server" CTA. */
  canPostToServer: boolean;
  /** Render without the outer card chrome — the parent owns it. */
  flush?: boolean;
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
      flush={flush}
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
      <div className="text-[12px] text-gray-400 tabular-nums mb-3 flex items-center justify-between gap-2">
        <span>
          <span className="text-gray-200 font-semibold">{wants.length}</span>
          {wants.length === 1 ? ' card' : ' cards'}
          {priorityCount > 0 && (
            <>
              {' · '}
              <span className="text-gold font-semibold">{priorityCount}</span>
              {' priority'}
            </>
          )}
        </span>
        {canPostToServer && wants.length > 0 && (
          <a
            href={priorityCount > 0 ? '/?signals=new&prefill=priorities' : '/?signals=new'}
            className="text-[11px] text-gray-500 hover:text-gold font-medium transition-colors whitespace-nowrap"
          >
            Post to a server →
          </a>
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
          {visible.map((w) => {
            const card = cardByFamily.get(w.familyId);
            return (
              <li key={w.id}>
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
      {wants.length > LIST_MODULE_CAP && (
        <button
          type="button"
          onClick={onEditWishlist}
          className="mt-2 w-full text-[11px] text-gray-500 hover:text-gold font-medium transition-colors text-center py-1"
        >
          +{wants.length - LIST_MODULE_CAP} more →
        </button>
      )}
    </ModuleSection>
  );
}

// --- 📘 Your binder module ------------------------------------------------

function BinderModule({
  available,
  cardByProductId,
  onEditBinder,
  canPostToServer,
  flush = false,
}: {
  available: AvailableItem[];
  cardByProductId: Map<string, CardVariant>;
  onEditBinder: () => void;
  canPostToServer: boolean;
  /** Render without the outer card chrome — the parent owns it. */
  flush?: boolean;
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
      flush={flush}
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
      <div className="text-[12px] text-gray-400 tabular-nums mb-3 flex items-center justify-between gap-2">
        <span>
          <span className="text-gray-200 font-semibold">{available.length}</span>
          {available.length === 1 ? ' card available' : ' cards available'}
        </span>
        {canPostToServer && available.length > 0 && (
          <a
            href="/?signals=new&kind=offering"
            className="text-[11px] text-gray-500 hover:text-gold font-medium transition-colors whitespace-nowrap"
          >
            Post to a server →
          </a>
        )}
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
          {visible.map((a) => {
            const card = cardByProductId.get(a.productId);
            return (
              <li key={a.id}>
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
      {available.length > LIST_MODULE_CAP && (
        <button
          type="button"
          onClick={onEditBinder}
          className="mt-2 w-full text-[11px] text-gray-500 hover:text-gold font-medium transition-colors text-center py-1"
        >
          +{available.length - LIST_MODULE_CAP} more →
        </button>
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
      {/* Skip the redundant counts line when there's only one server —
          the single guild row underneath already says "<name> · N
          traders", so the "1 server · N traders" line was just
          duplicating it and adding vertical weight. Multi-server
          users still see the rollup. */}
      {guilds.length > 1 && (
        <div className="text-[12px] text-gray-400 tabular-nums mb-3 flex flex-wrap gap-x-3 gap-y-1">
          <span>
            <span className="text-gray-200 font-semibold">{guilds.length}</span>
            {' servers'}
          </span>
          {totalTraders > 0 && (
            <span>
              <span className="text-gray-200 font-semibold">{totalTraders}</span>
              {totalTraders === 1 ? ' trader' : ' traders'}
            </span>
          )}
        </div>
      )}

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
  flush = false,
}: {
  icon: React.ReactNode;
  label: string;
  headingId: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** Drop the outer card chrome (border / bg / padding). Used when
   *  the module is rendered inside a parent that already provides a
   *  unified card frame (e.g. Wishlist + Binder packed into one
   *  shared "Collection" card on Home). The header + action layout
   *  stays unchanged so the module still reads as itself within the
   *  parent's frame. */
  flush?: boolean;
}) {
  return (
    <section
      aria-labelledby={headingId}
      // Each module sits in its own subtle panel. Gives the dashboard
      // a consistent "these are parallel things" visual rhythm without
      // heavy chrome — the space-800/20 wash is darker than the page
      // ground but lighter than the interactive rows within. Flush
      // mode skips this when the parent owns the chrome.
      className={flush ? '' : 'rounded-xl border border-space-700 bg-space-800/20 p-4'}
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

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
