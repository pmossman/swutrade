import { useMemo, useState } from 'react';
import type { AuthApi } from '../hooks/useAuth';
import { AppHeader } from './ui/AppHeader';
import { LoadingState } from './ui/states';
import {
  useTradesList,
  type TradeListEntry,
  type TradeActivityEntry,
  type TradeActivityType,
} from '../hooks/useTradesList';
import { useGuildMemberships, type GuildMembershipSummary } from '../hooks/useGuildMemberships';
import { HandlePickerDialog } from './HandlePickerDialog';
import { TradeExpandPeek } from './TradeExpandPeek';
import { useWants } from '../hooks/useWants';
import { useAvailable } from '../hooks/useAvailable';
import { useCardIndexContext } from '../contexts/CardIndexContext';
import { useDrawerContext } from '../contexts/DrawerContext';
import type { CardVariant } from '../types';
import type { WantsItem } from '../persistence/schemas';

interface HomeViewProps {
  auth: AuthApi;
  onOpenTrade: (tradeId: string) => void;
  onOpenTradesHistory: () => void;
  onOpenSettings: () => void;
  /** Deep-link into Settings > Discord servers (list view). Used by the
   *  "Manage" action on My Communities so the user lands next to the
   *  guild-level toggles, not at the Settings hub root. */
  onManageCommunities: () => void;
  onOpenCommunity: () => void;
  onBuildTrade: () => void;
  onOpenProfile: (handle: string) => void;
  /** Jump straight into the proposal composer against the given
   *  handle. Drives the "Propose a trade →" action on My Communities
   *  via HandlePickerDialog — caller is responsible for navigating to
   *  `/?propose=<handle>`. */
  onProposeTo: (handle: string) => void;
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
export function HomeView({
  auth,
  onOpenTrade,
  onOpenTradesHistory,
  onOpenSettings,
  onManageCommunities,
  onOpenCommunity,
  onBuildTrade,
  onOpenProfile,
  onProposeTo,
}: HomeViewProps) {
  const { user } = auth;
  const trades = useTradesList();
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

  const { needsResponse, tradeCounts } = useMemo(() => {
    const needs: TradeListEntry[] = [];
    let incoming = 0;
    let outgoing = 0;
    let resolved = 0;
    for (const t of trades.proposals) {
      if (t.status === 'pending') {
        if (t.direction === 'received') {
          needs.push(t);
          incoming += 1;
        } else {
          outgoing += 1;
        }
      } else {
        resolved += 1;
      }
    }
    return {
      needsResponse: needs,
      tradeCounts: { incoming, outgoing, resolved },
    };
  }, [trades.proposals]);

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
            proposals={needsResponse}
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
              status={trades.status}
              counts={tradeCounts}
              activity={trades.recentActivity}
              onOpenTrade={onOpenTrade}
              onOpenTradesHistory={onOpenTradesHistory}
              onBuildTrade={onBuildTrade}
              viewerHandle={user?.handle}
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
  proposals,
  onOpenTrade,
  onOpenTradesHistory,
}: {
  proposals: TradeListEntry[];
  onOpenTrade: (tradeId: string) => void;
  onOpenTradesHistory: () => void;
}) {
  const visible = proposals.slice(0, HOME_PROPOSAL_CAP);
  const overflow = proposals.length - visible.length;
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
          <span aria-hidden>⏰</span>
          <span>Needs your response</span>
          <span className="text-xs tabular-nums text-gold font-bold">{proposals.length}</span>
        </h2>
      </div>
      <ul className="flex flex-col gap-1.5">
        {visible.map(p => {
          const expanded = expandedId === p.id;
          return (
            <li key={p.id}>
              <TradeRow
                trade={p}
                onClick={() => setExpandedId(expanded ? null : p.id)}
                highlight
                expanded={expanded}
              />
              {expanded && (
                <TradeExpandPeek
                  proposalId={p.id}
                  onOpenDetail={() => onOpenTrade(p.id)}
                />
              )}
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
          See all {proposals.length} pending →
        </button>
      )}
    </section>
  );
}

// --- 💱 My Trades module ---------------------------------------------------

function TradesModule({
  status,
  counts,
  activity,
  onOpenTrade,
  onOpenTradesHistory,
  onBuildTrade,
  viewerHandle,
}: {
  status: 'loading' | 'ready' | 'error';
  counts: { incoming: number; outgoing: number; resolved: number };
  activity: TradeActivityEntry[];
  onOpenTrade: (tradeId: string) => void;
  onOpenTradesHistory: () => void;
  onBuildTrade: () => void;
  viewerHandle: string | undefined;
}) {
  const hasAny = counts.incoming + counts.outgoing + counts.resolved > 0;
  // A single expanded proposalId across the activity feed so opening
  // one row collapses any other. Separate from the callout's state —
  // the two lists show different proposals and we don't try to keep
  // a selection in sync.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <ModuleSection
      icon="💱"
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
      <div className="text-[12px] text-gray-400 tabular-nums mb-3">
        <span className="text-gray-200 font-semibold">{counts.incoming}</span>
        {' incoming · '}
        <span className="text-gray-200 font-semibold">{counts.outgoing}</span>
        {' outgoing · '}
        <span className="text-gray-200 font-semibold">{counts.resolved}</span>
        {' resolved'}
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
            Balance a trade
          </button>
          {' to get started — share it with a friend or send it in-app.'}
        </div>
      )}
      {status !== 'loading' && hasAny && activity.length === 0 && (
        <div className="rounded-lg bg-space-800/20 border border-dashed border-space-700 px-4 py-3 text-[11px] text-gray-500">
          No recent activity yet. Accepts, counters, and nudges will show up here.
        </div>
      )}
      {activity.length > 0 && (
        <ul className="flex flex-col gap-1">
          {/* Mobile shows 3, desktop 5 — matches the module-pattern
              spec ("richer on desktop"). Items past the desktop cap
              stay hidden; the overflow link in the header covers them. */}
          {activity.map((a, idx) => {
            const peekKey = `${a.proposalId}-${a.createdAt}-${idx}`;
            const expanded = expandedId === peekKey;
            return (
              <li
                key={peekKey}
                className={idx >= 3 ? 'hidden lg:list-item' : undefined}
              >
                <ActivityRow
                  activity={a}
                  viewerHandle={viewerHandle}
                  expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : peekKey)}
                />
                {expanded && (
                  <TradeExpandPeek
                    proposalId={a.proposalId}
                    onOpenDetail={() => onOpenTrade(a.proposalId)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </ModuleSection>
  );
}

function ActivityRow({
  activity,
  viewerHandle,
  onClick,
  expanded,
}: {
  activity: TradeActivityEntry;
  viewerHandle: string | undefined;
  onClick: () => void;
  expanded?: boolean;
}) {
  const actorLabel = activity.actor
    ? (activity.actor.handle === viewerHandle ? 'You' : `@${activity.actor.handle}`)
    : 'System';
  const verb = verbForActivityType(activity.type);
  // Subject: for actions taken *on* the viewer's proposal by someone
  // else, read "your proposal"; for actions the viewer took, read
  // "your proposal to @X"; for system-generated (expired) it's just
  // "the proposal".
  const subject = (() => {
    if (actorLabel === 'You') {
      return activity.counterpartHandle ? `your proposal to @${activity.counterpartHandle}` : 'your proposal';
    }
    if (activity.actor) return 'your proposal';
    return 'a proposal';
  })();
  const when = timeAgoShort(activity.createdAt);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors text-left ${
        expanded
          ? 'bg-space-800/70 border-gold/40'
          : 'bg-space-800/30 border-space-700 hover:border-gold/30 hover:bg-space-800/50'
      }`}
    >
      <span aria-hidden className="text-base leading-none shrink-0">{glyphForActivityType(activity.type)}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-gray-200 truncate">
          <span className="font-medium">{actorLabel}</span>{' '}
          <span className="text-gray-400">{verb}</span>{' '}
          <span className="text-gray-400">{subject}</span>
        </div>
      </div>
      <span className="text-[11px] text-gray-500 tabular-nums shrink-0">{when}</span>
    </button>
  );
}

function verbForActivityType(t: TradeActivityType): string {
  switch (t) {
    case 'accepted':  return 'accepted';
    case 'declined':  return 'declined';
    case 'cancelled': return 'cancelled';
    case 'countered': return 'countered';
    case 'edited':    return 'edited';
    case 'nudged':    return 'nudged';
    case 'expired':   return 'expired on';
  }
}

function glyphForActivityType(t: TradeActivityType): string {
  switch (t) {
    case 'accepted':  return '✅';
    case 'declined':  return '🛑';
    case 'cancelled': return '↩️';
    case 'countered': return '🔁';
    case 'edited':    return '✏️';
    case 'nudged':    return '👋';
    case 'expired':   return '⌛';
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
      icon="📋"
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
}: {
  guilds: GuildMembershipSummary[];
  status: 'loading' | 'ready' | 'saving' | 'error';
  onOpenSettings: () => void;
  onManageCommunities: () => void;
  onOpenCommunity: () => void;
  onOpenHandlePicker: () => void;
}) {
  return (
    <ModuleSection
      icon="👥"
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
          <span aria-hidden>🏪</span>
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
  icon: string;
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
          <span aria-hidden className="text-base leading-none">{icon}</span>
          <span>{label}</span>
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// --- Rows / shared UI ------------------------------------------------------

function TradeRow({
  trade,
  onClick,
  highlight,
  expanded,
}: {
  trade: TradeListEntry;
  onClick: () => void;
  highlight?: boolean;
  /** When true the chevron rotates to match the open peek below. The
   *  row itself doesn't visually grow — the peek renders as a sibling
   *  block below it in the list. */
  expanded?: boolean;
}) {
  const counterpart = trade.counterpart;
  const label = counterpart ? `@${counterpart.handle}` : 'Unknown trader';
  // Viewer-centric grammar. For a received proposal, the counterpart is
  // offering `offeringCount` to me and asking for `receivingCount` from
  // me — so "Receive X · Give Y" reads directly. Sent is the mirror.
  const detail = trade.direction === 'received'
    ? `Receive ${trade.receivingCount} · Give ${trade.offeringCount}`
    : `Offer ${trade.offeringCount} · Want ${trade.receivingCount}`;
  const when = timeAgoShort(trade.updatedAt);
  const previewBits: string[] = [];
  if (trade.topCard) {
    const variant = trade.topCard.variant;
    const variantSuffix = variant && variant.toLowerCase() !== 'standard'
      ? ` (${formatVariant(variant)})`
      : '';
    previewBits.push(`${trade.topCard.name}${variantSuffix}`);
  }
  if (trade.hasMessage) previewBits.push('has message');
  const preview = previewBits.join(' · ');

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left ${
        highlight
          ? 'bg-gold/8 border-gold/40 hover:border-gold/60 hover:bg-gold/12'
          : 'bg-space-800/40 border-space-700 hover:border-gold/30'
      }`}
    >
      <Avatar avatarUrl={counterpart?.avatarUrl ?? null} name={counterpart?.username || counterpart?.handle || '?'} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-100 truncate">
            {label}
          </span>
          <span className="text-[11px] text-gray-500 tabular-nums shrink-0">
            {when}
          </span>
        </div>
        <div className="text-[11px] text-gray-500 mt-0.5 truncate">
          {detail}
          {preview && ` · ${preview}`}
        </div>
      </div>
      <ChevronIcon
        className={`w-4 h-4 text-gray-500 shrink-0 transition-transform ${
          expanded ? 'rotate-0' : '-rotate-90'
        }`}
      />
    </button>
  );
}

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

function formatVariant(variant: string): string {
  const lower = variant.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
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
