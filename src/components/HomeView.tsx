import { useCallback, useMemo, useState } from 'react';
import {
  AlarmClock,
  ArrowLeftRight,
  ClipboardList,
  Store,
  Users,
} from 'lucide-react';
import type { AuthApi } from '../hooks/useAuth';
import { AppHeader } from './ui/AppHeader';
import { LoadingState } from './ui/states';
import { useMyTrades, type TradeRow, type TradeRowState } from '../hooks/useMyTrades';
import { useGuildMemberships, type GuildMembershipSummary } from '../hooks/useGuildMemberships';
import { HandlePickerDialog } from './HandlePickerDialog';
import { TradeExpandPeek } from './TradeExpandPeek';
import { apiPost } from '../services/apiClient';
import { useWants } from '../hooks/useWants';
import { useAvailable } from '../hooks/useAvailable';
import { useCardIndexContext } from '../contexts/CardIndexContext';
import { useDrawerContext } from '../contexts/DrawerContext';
import { useNavigation } from '../contexts/NavigationContext';
import type { CardVariant } from '../types';
import type { WantsItem } from '../persistence/schemas';

interface HomeViewProps {
  auth: AuthApi;
}

/**
 * Home 2.0 — dashboard layout.
 *
 * Four parallel "my" modules each own a surface in the IA:
 *
 *   💱 My Trades       → trades history + recent activity
 *   📋 My Lists        → wants + available (ListsDrawer)
 *   👥 My Communities  → enrolled Discord servers
 *   🏪 My Stores       → LGS placeholder (Phase 4 v2+)
 *
 * Plus a pinned ⏰ "Needs your response" callout at the top whenever
 * the viewer has open received proposals. The four-module pattern
 * replaces the earlier two-column mailbox layout — beta feedback
 * was that 📥/📤 read as "same mailbox thing" and that a flat
 * two-column split felt arbitrary.
 *
 * Desktop grid splits action surfaces (left: response + trades)
 * from resource surfaces (right: lists + communities) with the
 * Stores placeholder spanning the full width as a footer.
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
  const onOpenSettings = () => nav.toSettings();
  const onManageCommunities = () => nav.toSettings({ tab: 'servers' });
  const onOpenCommunity = () => nav.toCommunity();
  const onBuildTrade = nav.toBuildTrade;
  const onOpenProfile = nav.toProfile;
  const onProposeTo = nav.toProposeWith;
  // `useMyTrades` is the unified view layer — merges proposals +
  // sessions into one TradeRow stream. The older `useTradesList` is
  // still consulted for the `needsResponse` callout (which already
  // had overflow/highlight chrome tuned to the proposal shape) but
  // everything inside the My Trades module reads from `myTrades`.
  const myTrades = useMyTrades();
  const guilds = useGuildMemberships();
  const wants = useWants();
  const available = useAvailable();
  // CardIndexContext keeps the byFamily index globally synced — no
  // need for this view to re-trigger `loadAllSets`, the PriceData
  // provider handles that once at app mount. DrawerContext gives us
  // the shared open-state so the drawer at App root responds here.
  const { byFamily } = useCardIndexContext();
  const { openLists } = useDrawerContext();
  const [handlePickerOpen, setHandlePickerOpen] = useState(false);
  const [startingOpen, setStartingOpen] = useState(false);

  // Open/QR trade entry — POSTs /api/sessions/create-open, navigates
  // to /s/<id> where the creator sees their own QR + a link. No
  // counterpart handle required; a scanner claims the slot when the
  // QR is shown in person (or the link shared any other way).
  const handleStartOpenTrade = useCallback(async () => {
    if (startingOpen) return;
    setStartingOpen(true);
    try {
      const result = await apiPost<{ id: string }>('/api/sessions/create-open', { initialCards: [] });
      if (result.ok) nav.toSession(result.data.id);
    } finally {
      setStartingOpen(false);
    }
  }, [nav, startingOpen]);

  // `myTrades` already derives `needsResponse` + `counts` across the
  // unified proposal + session stream, so we don't redo that work here.
  const { needsResponse } = myTrades;
  const tradeCounts = myTrades.counts;

  const enrolledGuilds = useMemo(
    () => guilds.enrollable.filter(g => g.enrolled),
    [guilds.enrollable],
  );

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      {/* Home is the root view for signed-in users — no breadcrumbs,
          AppHeader's logo + NavMenu + AccountMenu anchor the page.
          The Lists drawer lives at App root now, so we just toggle the
          shared open-state via DrawerContext rather than rendering our
          own <ListsDrawer> instance. */}
      <AppHeader auth={auth} onOpenLists={openLists} />

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-4 max-w-5xl mx-auto w-full flex flex-col gap-6">
        {user && (
          <GreetingRow
            user={user}
            onOpenProfile={onOpenProfile}
            onBuildTrade={onBuildTrade}
            onOpenTradesHistory={onOpenTradesHistory}
          />
        )}

        {/* Needs-response callout is full-width above the grid so it
            reads as "everything else waits — deal with this first." */}
        {needsResponse.length > 0 && (
          <NeedsResponseCallout
            rows={needsResponse}
            onOpenTrade={onOpenTrade}
            onOpenTradesHistory={onOpenTradesHistory}
          />
        )}

        {/* Desktop: CSS grid with explicit column tracks pairs action
            surfaces (Trades, Response) on the left with resource
            surfaces (Lists, Communities) on the right. Mobile: flows
            to a single column in priority order (trades, lists,
            communities, stores). gap-6 for mobile breathing room;
            lg:gap-8 for the tighter-pair desktop split. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
          <div className="flex flex-col gap-6">
            <TradesModule
              status={myTrades.status}
              counts={tradeCounts}
              rows={myTrades.rows}
              onOpenTrade={onOpenTrade}
              onOpenTradesHistory={onOpenTradesHistory}
              onBuildTrade={onBuildTrade}
            />

            <ListsModule
              wants={wants.items}
              availableCount={available.items.length}
              cardByFamily={byFamily}
              onEditLists={openLists}
            />
          </div>

          <div className="flex flex-col gap-6">
            <CommunitiesModule
              guilds={enrolledGuilds}
              status={guilds.status}
              onOpenSettings={onOpenSettings}
              onManageCommunities={onManageCommunities}
              onOpenCommunity={onOpenCommunity}
              onOpenHandlePicker={() => setHandlePickerOpen(true)}
              onStartOpenTrade={handleStartOpenTrade}
              startingOpen={startingOpen}
            />
          </div>
        </div>

        <StoresModule />
      </main>

      <HandlePickerDialog
        open={handlePickerOpen}
        onClose={() => setHandlePickerOpen(false)}
        onPick={handle => {
          setHandlePickerOpen(false);
          onProposeTo(handle);
        }}
      />
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
  user: { handle: string; username: string; avatarUrl: string | null };
  onOpenProfile: (handle: string) => void;
  onBuildTrade: () => void;
  onOpenTradesHistory: () => void;
}) {
  const displayName = user.username && user.username !== user.handle ? user.username : `@${user.handle}`;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => onOpenProfile(user.handle)}
        aria-label="Open your public profile"
        className="shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-gold/60"
      >
        <Avatar avatarUrl={user.avatarUrl} name={user.username || user.handle} />
      </button>
      <div className="min-w-0 mr-auto">
        <div className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">
          Welcome back
        </div>
        <div className="text-lg font-semibold text-gray-100 truncate">{displayName}</div>
      </div>
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
          Balance a trade
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

// --- 📋 My Lists module ----------------------------------------------------

function ListsModule({
  wants,
  availableCount,
  cardByFamily,
  onEditLists,
}: {
  wants: WantsItem[];
  availableCount: number;
  cardByFamily: Map<string, CardVariant>;
  onEditLists: () => void;
}) {
  const priorityWants = useMemo(() => {
    return wants.filter(w => w.isPriority).slice(0, 5);
  }, [wants]);

  return (
    <ModuleSection
      icon={<ClipboardList aria-hidden className="w-4 h-4" />}
      label="My Lists"
      headingId="my-lists-heading"
      action={
        <button
          type="button"
          onClick={onEditLists}
          className="text-[11px] text-gray-500 hover:text-gold font-medium transition-colors"
        >
          Edit lists →
        </button>
      }
    >
      <div className="text-[12px] text-gray-400 tabular-nums mb-3">
        <span className="text-gray-200 font-semibold">{wants.length}</span>
        {' wants · '}
        <span className="text-gray-200 font-semibold">{availableCount}</span>
        {' available'}
      </div>

      {wants.length === 0 && availableCount === 0 && (
        <div className="rounded-lg bg-space-800/30 border border-space-700 px-4 py-3 text-xs text-gray-500 leading-relaxed">
          No lists yet.{' '}
          <button
            type="button"
            onClick={onEditLists}
            className="text-gold hover:text-gold-bright underline font-semibold"
          >
            Add cards you want or have
          </button>
          {' — others with matching lists can find you.'}
        </div>
      )}
      {wants.length > 0 && priorityWants.length === 0 && (
        <div className="rounded-lg bg-space-800/20 border border-dashed border-space-700 px-4 py-3 text-[11px] text-gray-500 leading-relaxed">
          Star a want to mark it a priority — priorities show up first here and in matchmaking.
        </div>
      )}
      {priorityWants.length > 0 && (
        <ul className="flex flex-col gap-1">
          {priorityWants.map((w, idx) => {
            const card = cardByFamily.get(w.familyId);
            const name = card?.name ?? 'Priority card';
            return (
              <li
                key={w.id}
                className={idx >= 2 ? 'hidden lg:list-item' : undefined}
              >
                <button
                  type="button"
                  onClick={onEditLists}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-space-800/30 border border-space-700 hover:border-gold/30 hover:bg-space-800/50 transition-colors text-left"
                >
                  <span aria-hidden className="text-gold text-sm leading-none shrink-0">★</span>
                  <span className="flex-1 text-[12px] text-gray-200 truncate">{name}</span>
                  <span className="text-[11px] text-gray-500 tabular-nums shrink-0">×{w.qty}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </ModuleSection>
  );
}

// --- 👥 My Communities module ----------------------------------------------

function CommunitiesModule({
  guilds,
  status,
  onOpenSettings,
  onManageCommunities,
  onOpenCommunity,
  onOpenHandlePicker,
  onStartOpenTrade,
  startingOpen,
}: {
  guilds: GuildMembershipSummary[];
  status: 'loading' | 'ready' | 'saving' | 'error';
  onOpenSettings: () => void;
  onManageCommunities: () => void;
  onOpenCommunity: () => void;
  onOpenHandlePicker: () => void;
  onStartOpenTrade: () => void;
  startingOpen: boolean;
}) {
  return (
    <ModuleSection
      icon={<Users aria-hidden className="w-4 h-4" />}
      label="My Communities"
      headingId="my-communities-heading"
      action={
        <button
          type="button"
          onClick={onManageCommunities}
          className="text-[11px] text-gray-500 hover:text-gold font-medium transition-colors"
        >
          Manage →
        </button>
      }
    >
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <div className="text-[12px] text-gray-400 tabular-nums">
          <span className="text-gray-200 font-semibold">{guilds.length}</span>
          {guilds.length === 1 ? ' community' : ' communities'}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onStartOpenTrade}
            disabled={startingOpen}
            className="text-[11px] text-cyan-300 hover:text-cyan-200 font-medium transition-colors disabled:opacity-60"
            title="Generate a QR/link to invite someone into a shared trade — great for in-person at the LGS"
          >
            {startingOpen ? 'Starting…' : 'Share QR →'}
          </button>
          {guilds.length > 0 && (
            <button
              type="button"
              onClick={onOpenHandlePicker}
              className="text-[11px] text-gold hover:text-gold-bright font-medium transition-colors"
            >
              Propose a trade →
            </button>
          )}
        </div>
      </div>

      {status === 'loading' && <LoadingState label="Loading your communities…" />}
      {status !== 'loading' && guilds.length === 0 && (
        <div className="rounded-lg bg-space-800/30 border border-space-700 px-4 py-3 text-xs text-gray-500 leading-relaxed">
          You haven't enrolled in any Discord communities yet.{' '}
          <button
            type="button"
            onClick={onOpenSettings}
            className="text-gold hover:text-gold-bright underline font-semibold"
          >
            Find a server to enroll in
          </button>
          {' '}and you'll see its members' wants + available here.
        </div>
      )}
      {guilds.length > 0 && (
        <ul className="flex flex-col gap-1">
          {guilds.map((g, idx) => (
            <li
              key={g.guildId}
              // Mobile shows 2; desktop widens to 4. Keeps the right
              // column from dominating the fold on a phone.
              className={idx >= 2 ? 'hidden lg:list-item' : undefined}
            >
              <GuildCard guild={g} onClick={onOpenCommunity} />
            </li>
          ))}
        </ul>
      )}
    </ModuleSection>
  );
}

function GuildCard({
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
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-space-800/30 border border-space-700 hover:border-gold/30 hover:bg-space-800/50 transition-colors text-left"
    >
      <GuildAvatar guild={guild} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-gray-100 truncate">{guild.guildName}</div>
        <div className="text-[11px] text-gray-500 mt-0.5">
          Enrolled
          {guild.canManage && ' · You manage this server'}
        </div>
      </div>
      <ChevronIcon className="w-4 h-4 text-gray-500 shrink-0 -rotate-90" />
    </button>
  );
}

// --- 🏪 My Stores module (placeholder, Phase 4 v2+) -----------------------

function StoresModule() {
  // Full-width footer module. Dimmed + dashed border so it reads as
  // "reserved real estate" — layout stays stable when LGS ships.
  return (
    <section aria-labelledby="my-stores-heading">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h2
          id="my-stores-heading"
          className="flex items-center gap-2 text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold"
        >
          <Store aria-hidden className="w-4 h-4" />
          <span>My Stores</span>
        </h2>
        <span className="text-[11px] text-gray-600 font-medium">Coming soon</span>
      </div>
      <div className="rounded-lg bg-space-800/20 border border-dashed border-space-700 px-4 py-3 text-[11px] text-gray-600 leading-relaxed">
        Local game store integration, meetup announcements, and in-person trade-night signals will live here.
      </div>
    </section>
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

function GuildAvatar({ guild }: { guild: GuildMembershipSummary }) {
  const initial = guild.guildName.trim().slice(0, 1).toUpperCase() || '?';
  if (guild.guildIcon) {
    const url = `https://cdn.discordapp.com/icons/${guild.guildId}/${guild.guildIcon}.png?size=64`;
    return <img src={url} alt="" className="w-9 h-9 rounded-full shrink-0" />;
  }
  return (
    <span
      aria-hidden
      className="w-9 h-9 rounded-full bg-space-700 text-gold font-bold flex items-center justify-center shrink-0 text-sm"
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
