import { useMemo, useState } from 'react';
import type { AuthApi } from '../hooks/useAuth';
import { PageHeader } from './ui/PageHeader';
import { LoadingState } from './ui/states';
import { useTradesList, type TradeListEntry } from '../hooks/useTradesList';
import { useGuildMemberships, type GuildMembershipSummary } from '../hooks/useGuildMemberships';
import { AccountMenu } from './AccountMenu';
import { ListsDrawer } from './ListsDrawer';
import { useWants } from '../hooks/useWants';
import { useAvailable } from '../hooks/useAvailable';
import { usePriceData } from '../hooks/usePriceData';

interface HomeViewProps {
  auth: AuthApi;
  onOpenTrade: (tradeId: string) => void;
  onOpenTradesHistory: () => void;
  onOpenSettings: () => void;
  /** Deep-link into Settings > Discord servers (list view). Used by the
   *  "Manage" action on Your Communities so the user lands next to the
   *  guild-level toggles, not at the Settings hub root. */
  onManageCommunities: () => void;
  onOpenCommunity: () => void;
  onBuildTrade: () => void;
  onOpenProfile: (handle: string) => void;
}

/**
 * Signed-in landing page. Surfaces the three things a returning user
 * cares about the most:
 *   1. Trades that need their response right now.
 *   2. Trades they've sent that are waiting on someone else.
 *   3. The communities they're part of (Discord guilds) — entry point
 *      to the broader social layer.
 *
 * The trade balancer itself ("Build a trade") is a deliberate primary
 * CTA rather than the default view — we don't want signed-in users to
 * see an empty card picker every time they open the app.
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
}: HomeViewProps) {
  const { user } = auth;
  const trades = useTradesList();
  const guilds = useGuildMemberships();
  const wants = useWants();
  const available = useAvailable();
  const priceData = usePriceData();
  const [listsDrawerOpen, setListsDrawerOpen] = useState(false);

  const allLoadedCards = useMemo(
    () => Object.values(priceData.cards).flat(),
    [priceData.cards],
  );

  const { needsResponse, waitingOnOthers } = useMemo(() => {
    const needs: TradeListEntry[] = [];
    const waiting: TradeListEntry[] = [];
    for (const t of trades.proposals) {
      if (t.status !== 'pending') continue;
      if (t.direction === 'received') needs.push(t);
      else waiting.push(t);
    }
    return { needsResponse: needs, waitingOnOthers: waiting };
  }, [trades.proposals]);

  const enrolledGuilds = useMemo(
    () => guilds.enrollable.filter(g => g.enrolled),
    [guilds.enrollable],
  );

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <div className="px-3 sm:px-6 pt-3 pb-2 max-w-5xl mx-auto w-full">
        <PageHeader>
          <AccountMenu auth={auth} onOpenLists={() => setListsDrawerOpen(true)} />
        </PageHeader>
      </div>

      <ListsDrawer
        wants={wants}
        available={available}
        allCards={allLoadedCards}
        percentage={100}
        priceMode="market"
        open={listsDrawerOpen}
        onOpenChange={setListsDrawerOpen}
      />

      {/* Layout: mobile stacks everything single-column in priority
          order. Desktop (`lg+`) splits into two columns after the
          greeting + primary actions — actionable trades on the left,
          community/context on the right — so horizontal space isn't
          wasted. Bump max-w from 3xl → 5xl here to give the grid room. */}
      <main className="flex-1 px-3 sm:px-6 pb-12 pt-4 max-w-5xl mx-auto w-full flex flex-col gap-6">
        {user && <GreetingRow user={user} onOpenProfile={onOpenProfile} />}

        <PrimaryActions
          onBuildTrade={onBuildTrade}
          onOpenTradesHistory={onOpenTradesHistory}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
          <div className="flex flex-col gap-6">
            <NeedsResponseSection
              status={trades.status}
              proposals={needsResponse}
              onOpenTrade={onOpenTrade}
              onOpenTradesHistory={onOpenTradesHistory}
            />

            <WaitingOnOthersSection
              proposals={waitingOnOthers}
              onOpenTrade={onOpenTrade}
              onOpenTradesHistory={onOpenTradesHistory}
            />
          </div>

          <div className="flex flex-col gap-6">
            <CommunitiesSection
              guilds={enrolledGuilds}
              status={guilds.status}
              onOpenSettings={onOpenSettings}
              onManageCommunities={onManageCommunities}
              onOpenCommunity={onOpenCommunity}
            />

            <UpcomingSection />
          </div>
        </div>
      </main>
    </div>
  );
}

// --- Greeting / identity ---------------------------------------------------

function GreetingRow({
  user,
  onOpenProfile,
}: {
  user: { handle: string; username: string; avatarUrl: string | null };
  onOpenProfile: (handle: string) => void;
}) {
  const displayName = user.username && user.username !== user.handle ? user.username : `@${user.handle}`;
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onOpenProfile(user.handle)}
        aria-label="Open your public profile"
        className="shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-gold/60"
      >
        <Avatar avatarUrl={user.avatarUrl} name={user.username || user.handle} />
      </button>
      <div className="min-w-0">
        <div className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">
          Welcome back
        </div>
        <div className="text-lg font-semibold text-gray-100 truncate">{displayName}</div>
      </div>
    </div>
  );
}

// --- Primary actions -------------------------------------------------------

function PrimaryActions({
  onBuildTrade,
  onOpenTradesHistory,
}: {
  onBuildTrade: () => void;
  onOpenTradesHistory: () => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-2">
      <button
        type="button"
        onClick={onBuildTrade}
        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-gold text-space-900 font-bold text-sm hover:bg-gold-bright transition-colors"
      >
        <PlusIcon className="w-4 h-4" />
        Build a trade
      </button>
      <button
        type="button"
        onClick={onOpenTradesHistory}
        className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-sm font-medium text-gray-300 hover:text-gold transition-colors"
      >
        Trade history
      </button>
    </div>
  );
}

// --- Needs your response ---------------------------------------------------

// Cap on the Home screen so a user with dozens of pending proposals
// doesn't get an endless wall — they see the N freshest and drop into
// the full Trades history for the rest.
const HOME_PROPOSAL_CAP = 5;

function NeedsResponseSection({
  status,
  proposals,
  onOpenTrade,
  onOpenTradesHistory,
}: {
  status: 'loading' | 'ready' | 'error';
  proposals: TradeListEntry[];
  onOpenTrade: (tradeId: string) => void;
  onOpenTradesHistory: () => void;
}) {
  const visible = proposals.slice(0, HOME_PROPOSAL_CAP);
  const overflow = proposals.length - visible.length;
  return (
    <section aria-labelledby="needs-response-heading">
      <SectionHeader
        id="needs-response-heading"
        icon="📥"
        label="Needs your response"
        count={proposals.length}
        emphasise
      />
      {status === 'loading' && <LoadingState label="Checking for new proposals…" />}
      {status === 'ready' && proposals.length === 0 && (
        <div className="rounded-lg bg-space-800/30 border border-space-700 px-4 py-3 text-xs text-gray-500">
          You're all caught up.
        </div>
      )}
      {visible.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {visible.map(p => (
            <TradeRow key={p.id} trade={p} onClick={() => onOpenTrade(p.id)} highlight />
          ))}
        </ul>
      )}
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

// --- Waiting on others -----------------------------------------------------

function WaitingOnOthersSection({
  proposals,
  onOpenTrade,
  onOpenTradesHistory,
}: {
  proposals: TradeListEntry[];
  onOpenTrade: (tradeId: string) => void;
  onOpenTradesHistory: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (proposals.length === 0) return null;

  const visible = proposals.slice(0, HOME_PROPOSAL_CAP);
  const overflow = proposals.length - visible.length;

  return (
    <section aria-labelledby="waiting-heading">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-3 rounded-lg bg-space-800/30 border border-space-700 hover:border-gold/30 px-4 py-3 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span aria-hidden>📤</span>
          <span id="waiting-heading" className="text-sm font-medium text-gray-200">
            Waiting on others
          </span>
          <span className="text-[11px] text-gray-500">
            {proposals.length}
          </span>
        </div>
        <ChevronIcon className={`w-4 h-4 text-gray-500 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <>
          <ul className="flex flex-col gap-1.5 mt-2">
            {visible.map(p => (
              <TradeRow key={p.id} trade={p} onClick={() => onOpenTrade(p.id)} />
            ))}
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
        </>
      )}
    </section>
  );
}

// --- Communities -----------------------------------------------------------

function CommunitiesSection({
  guilds,
  status,
  onOpenSettings,
  onManageCommunities,
  onOpenCommunity,
}: {
  guilds: GuildMembershipSummary[];
  status: 'loading' | 'ready' | 'saving' | 'error';
  onOpenSettings: () => void;
  onManageCommunities: () => void;
  onOpenCommunity: () => void;
}) {
  return (
    <section aria-labelledby="communities-heading">
      <SectionHeader
        id="communities-heading"
        label="Your communities"
        action={
          <button
            type="button"
            onClick={onManageCommunities}
            className="text-[11px] text-gray-500 hover:text-gold font-medium transition-colors"
          >
            Manage
          </button>
        }
      />
      {status === 'loading' && <LoadingState label="Loading your communities…" />}
      {status !== 'loading' && guilds.length === 0 && (
        <div className="rounded-lg bg-space-800/30 border border-space-700 px-4 py-4 text-xs text-gray-500 leading-relaxed">
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
        <div className="flex flex-col gap-1.5">
          {guilds.map(g => (
            <GuildCard key={g.guildId} guild={g} onClick={onOpenCommunity} />
          ))}
        </div>
      )}
    </section>
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
      className="flex items-center gap-3 px-4 py-3 rounded-lg bg-space-800/40 border border-space-700 hover:border-gold/40 hover:bg-space-800/60 transition-colors text-left"
    >
      <GuildAvatar guild={guild} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-100 truncate">{guild.guildName}</div>
        <div className="text-[11px] text-gray-500 mt-0.5">
          Enrolled
          {guild.canManage && ' · You manage this server'}
        </div>
      </div>
      <ChevronIcon className="w-4 h-4 text-gray-500 shrink-0 -rotate-90" />
    </button>
  );
}

// --- Upcoming / LGS placeholder --------------------------------------------

function UpcomingSection() {
  // Reserved for Phase 5 LGS integration (meetup times, event reminders).
  // Lives as a dimmed placeholder so the layout stays stable when it
  // lights up — and so users get a hint that more is coming.
  return (
    <section aria-labelledby="upcoming-heading">
      <SectionHeader id="upcoming-heading" icon="📅" label="Upcoming" />
      <div className="rounded-lg bg-space-800/20 border border-dashed border-space-700 px-4 py-3 text-[11px] text-gray-600 leading-relaxed">
        Local game store meetups and scheduled trade nights will show up here.
      </div>
    </section>
  );
}

// --- Rows / shared UI ------------------------------------------------------

function TradeRow({
  trade,
  onClick,
  highlight,
}: {
  trade: TradeListEntry;
  onClick: () => void;
  highlight?: boolean;
}) {
  const counterpart = trade.counterpart;
  const label = counterpart ? `@${counterpart.handle}` : 'Unknown trader';
  // Viewer-centric grammar. For a received proposal, the counterpart is
  // offering `offeringCount` to me and asking for `receivingCount` from
  // me — so "Receive X · Give Y" reads directly. Sent is the mirror.
  // Consistent with trades-history's `Offer ↔ Receive` vocab so the two
  // surfaces don't teach conflicting phrasing.
  const detail = trade.direction === 'received'
    ? `Receive ${trade.receivingCount} · Give ${trade.offeringCount}`
    : `Offer ${trade.offeringCount} · Want ${trade.receivingCount}`;
  const when = timeAgoShort(trade.updatedAt);
  // Preview line: top-card hint + message flag, truncated so the row
  // stays two lines on mobile. Variant appended only when non-standard
  // ("Luke · Standard" would read as noise).
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
    <li>
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
        <ChevronIcon className="w-4 h-4 text-gray-500 shrink-0 -rotate-90" />
      </button>
    </li>
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
  // Variants arrive uppercase ("HYPERSPACE FOIL"). Title-case the whole
  // string for inline reading — `(Hyperspace foil)`.
  const lower = variant.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function SectionHeader({
  id,
  icon,
  label,
  count,
  emphasise,
  action,
}: {
  id?: string;
  icon?: string;
  label: string;
  count?: number;
  emphasise?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-2">
      <h2
        id={id}
        className={`flex items-center gap-2 ${
          emphasise
            ? 'text-sm font-bold text-gray-100'
            : 'text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold'
        }`}
      >
        {icon && <span aria-hidden>{icon}</span>}
        <span>{label}</span>
        {typeof count === 'number' && count > 0 && (
          <span className="text-xs tabular-nums text-gold font-bold">
            {count}
          </span>
        )}
      </h2>
      {action}
    </div>
  );
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
    return <img src={url} alt="" className="w-10 h-10 rounded-full shrink-0" />;
  }
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
