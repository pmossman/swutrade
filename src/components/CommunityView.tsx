import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppHeader, type BreadcrumbSegment } from './ui/AppHeader';
import { LoadingState, ErrorState, EmptyState } from './ui/states';
import {
  useCommunityMembers,
  type CommunityMember,
} from '../hooks/useCommunityMembers';
import {
  useGuildMemberships,
  type GuildMembershipSummary,
} from '../hooks/useGuildMemberships';
import type { CardVariant } from '../types';
import { cardFamilyId } from '../variants';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import { useAuthContext } from '../contexts/AuthContext';
import { useCardIndexContext } from '../contexts/CardIndexContext';

interface CommunityViewProps {
  wants: WantsApi;
  available: AvailableApi;
}

type SortMode = 'overlap' | 'offer' | 'receive' | 'alpha';
type GuildTab = 'overview' | 'members' | 'popular' | 'upcoming';

interface MemberWithOverlap extends CommunityMember {
  iCanOfferThem: number;
  theyCanOfferMe: number;
  totalOverlap: number;
}

/**
 * Community 2.0 — guild-scoped spaces with tabs.
 *
 * Routing shape (query-param driven, bookmarkable, back-button
 * friendly via native `popstate` — mirrors SettingsView's drill-down
 * routing):
 *
 *   /?community=1                              — multi-guild selector
 *                                                (or auto-redirects to
 *                                                the single enrolled
 *                                                guild's Overview)
 *   /?community=1&guild=<id>                   — Overview tab
 *   /?community=1&guild=<id>&tab=<slug>        — specific tab
 *
 * Tab slugs: overview | members | popular | upcoming. Unknown falls
 * through to Overview.
 *
 * Overlap math (still client-side; only relevant in the Members tab):
 * the server returns each member's wantFamilyIds + availableProductIds,
 * and we intersect those against the viewer's own lists using the
 * productId → familyId lookup. We scope Members to the active guild
 * by filtering on `mutualGuildIds.includes(guild.guildId)`.
 *
 * Popular wants on the per-guild page are aggregated client-side
 * from the community members directory: a familyId wanted by N members
 * scores N. This keeps the endpoint surface unchanged — the community-
 * cards rollup exists but doesn't return counts, and the members
 * directory already has the data we need with the consent gates the
 * rollup enforces.
 */
export function CommunityView({ wants, available }: CommunityViewProps) {
  const { byProductId } = useCardIndexContext();
  const auth = useAuthContext();
  const community = useCommunityMembers();
  const guilds = useGuildMemberships();
  const { members, status: memberStatus } = community;

  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [sort, setSort] = useState<SortMode>('overlap');

  // Keep in-view state aligned with the browser URL on back/forward.
  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: Route, opts: { replace?: boolean } = {}) => {
    const url = buildUrl(next);
    if (opts.replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    setRoute(next);
  }, []);

  // Enrolled guilds only — non-enrolled entries shouldn't appear as
  // communities (they're just "visible to SWUTrade"). Matches the
  // bot-installed + user-enrolled intent of the rest of the view.
  const enrolledGuilds = useMemo(
    () => guilds.enrollable.filter(g => g.enrolled),
    [guilds.enrollable],
  );

  const guildsReady = guilds.status !== 'loading';

  // Single-guild redirect: if the viewer is enrolled in exactly one
  // guild and landed on the bare selector URL, skip straight to that
  // guild's Overview. Use replaceState so back doesn't loop them back
  // to a selector that would immediately redirect forward again.
  useEffect(() => {
    if (!guildsReady) return;
    if (route.guildId) return;
    if (enrolledGuilds.length === 1) {
      navigate({ guildId: enrolledGuilds[0].guildId, tab: 'overview' }, { replace: true });
    }
  }, [guildsReady, enrolledGuilds, route.guildId, navigate]);

  // Viewer's lists materialized as familyId sets — shared across
  // every member overlap computation. Memoized so re-renders from
  // sort/tab switches don't rescan the lists.
  const viewerAvailableFamilies = useMemo(() => {
    const s = new Set<string>();
    for (const item of available.items) {
      const card = byProductId.get(item.productId);
      if (card) s.add(cardFamilyId(card));
    }
    return s;
  }, [available.items, byProductId]);

  const viewerWantFamilies = useMemo(() => {
    const s = new Set<string>();
    for (const w of wants.items) s.add(w.familyId);
    return s;
  }, [wants.items]);

  // Guild lookup by id for header + breadcrumbs + deep-link validation.
  const activeGuild = useMemo<GuildMembershipSummary | null>(() => {
    if (!route.guildId) return null;
    return guilds.enrollable.find(g => g.guildId === route.guildId) ?? null;
  }, [route.guildId, guilds.enrollable]);

  // Members scoped to the active guild — populated even when the
  // active tab isn't Members, since Overview uses the top-3 slice.
  const guildMembers = useMemo<MemberWithOverlap[]>(() => {
    if (!route.guildId) return [];
    return members
      .filter(m => m.mutualGuildIds.includes(route.guildId!))
      .map(m => enrichMember(m, viewerAvailableFamilies, viewerWantFamilies, byProductId));
  }, [members, route.guildId, viewerAvailableFamilies, viewerWantFamilies, byProductId]);

  const sortedMembers = useMemo(() => sortMembers(guildMembers, sort), [guildMembers, sort]);

  const breadcrumbs = useMemo<BreadcrumbSegment[]>(() => {
    const root: BreadcrumbSegment = { label: 'Home', href: '/' };
    if (!route.guildId) {
      return [root, { label: 'Community' }];
    }
    return [
      root,
      { label: 'Community', href: '/?community=1' },
      { label: activeGuild?.guildName ?? 'Community' },
    ];
  }, [route.guildId, activeGuild]);

  // --- Content router ------------------------------------------------------

  let content: React.ReactNode;

  if (!guildsReady) {
    content = <LoadingState label="Loading your communities…" />;
  } else if (guilds.status === 'error' && enrolledGuilds.length === 0) {
    content = <ErrorState>Couldn't load your communities. Try refreshing.</ErrorState>;
  } else if (enrolledGuilds.length === 0) {
    content = <NoGuildsEmptyState />;
  } else if (!route.guildId) {
    // Multi-guild selector. Single-guild case was already redirected.
    content = <GuildSelector guilds={enrolledGuilds} navigate={navigate} />;
  } else if (!activeGuild) {
    // Deep-link to a guild the viewer isn't enrolled in (or that was
    // unenrolled since the link was shared). Surface an error and
    // offer the selector as the escape hatch.
    content = <StrandedGuildBanner navigate={navigate} />;
  } else {
    const tab = route.tab ?? 'overview';
    content = (
      <GuildSpace
        guild={activeGuild}
        tab={tab}
        navigate={navigate}
        memberStatus={memberStatus}
        guildMembers={guildMembers}
        sortedMembers={sortedMembers}
        sort={sort}
        onSortChange={setSort}
      />
    );
  }

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <AppHeader auth={auth} breadcrumbs={breadcrumbs} />
      <main className="flex-1 px-3 sm:px-6 pb-12 pt-2 max-w-3xl mx-auto w-full">
        <section className="mt-6" aria-labelledby="community-heading">
          <h2 id="community-heading" className="sr-only">
            {activeGuild ? `${activeGuild.guildName} community` : 'Community'}
          </h2>
          {content}
        </section>
      </main>
    </div>
  );
}

// --- Routing ---------------------------------------------------------------

interface Route {
  guildId?: string;
  tab?: GuildTab;
}

function parseRoute(): Route {
  if (typeof window === 'undefined') return {};
  const p = new URLSearchParams(window.location.search);
  const guildId = p.get('guild') ?? undefined;
  const rawTab = p.get('tab');
  const tab = rawTab === 'overview' || rawTab === 'members' || rawTab === 'popular' || rawTab === 'upcoming'
    ? rawTab
    : undefined;
  return { guildId, tab };
}

function buildUrl(route: Route): string {
  const p = new URLSearchParams(window.location.search);
  // Strip the keys this function owns so stale state doesn't leak
  // between navigations.
  for (const key of ['guild', 'tab']) p.delete(key);
  p.set('community', '1');
  if (route.guildId) p.set('guild', route.guildId);
  if (route.tab) p.set('tab', route.tab);
  return `${window.location.pathname}?${p.toString()}`;
}

// --- Guild selector --------------------------------------------------------

function NoGuildsEmptyState() {
  return (
    <EmptyState title="You haven't enrolled in any Discord servers yet.">
      Once SWUTrade's bot is in a server you're in, enroll from{' '}
      <a href="/?settings=1&tab=servers" className="text-gold hover:underline font-semibold">
        Settings → Discord servers
      </a>
      {' '}and this page will fill up with that server's trading community.
    </EmptyState>
  );
}

function StrandedGuildBanner({ navigate }: { navigate: (r: Route) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg bg-amber-500/10 border border-amber-400/30 px-3 py-2.5 text-[11px] text-amber-200 leading-relaxed">
        This community isn't available to you — you may have unenrolled, or
        SWUTrade's bot was removed from the server. Pick one of your enrolled
        communities below.
      </div>
      <button
        type="button"
        onClick={() => navigate({})}
        className="self-start px-3 h-8 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-300 hover:text-gold"
      >
        Back to all communities
      </button>
    </div>
  );
}

function GuildSelector({
  guilds,
  navigate,
}: {
  guilds: GuildMembershipSummary[];
  navigate: (r: Route) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Pick a server to see its trading community — members, wants, and
        what's happening there. Each server is its own space.
      </p>
      <div className="flex flex-col gap-1">
        {guilds.map(g => (
          <GuildSelectorRow
            key={g.guildId}
            guild={g}
            onClick={() => navigate({ guildId: g.guildId, tab: 'overview' })}
          />
        ))}
      </div>
    </div>
  );
}

function GuildSelectorRow({
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
          {formatMemberCount(guild)}
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
    </button>
  );
}

// --- Guild space (tabbed) --------------------------------------------------

function GuildSpace({
  guild,
  tab,
  navigate,
  memberStatus,
  guildMembers,
  sortedMembers,
  sort,
  onSortChange,
}: {
  guild: GuildMembershipSummary;
  tab: GuildTab;
  navigate: (r: Route) => void;
  memberStatus: 'loading' | 'ready' | 'error';
  guildMembers: MemberWithOverlap[];
  sortedMembers: MemberWithOverlap[];
  sort: SortMode;
  onSortChange: (s: SortMode) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <GuildHeader guild={guild} />
      <GuildTabs active={tab} onChange={next => navigate({ guildId: guild.guildId, tab: next })} />
      {tab === 'overview' && (
        <OverviewPanel
          guild={guild}
          navigate={navigate}
          memberStatus={memberStatus}
          guildMembers={guildMembers}
        />
      )}
      {tab === 'members' && (
        <MembersPanel
          memberStatus={memberStatus}
          guildMembers={guildMembers}
          sortedMembers={sortedMembers}
          sort={sort}
          onSortChange={onSortChange}
        />
      )}
      {tab === 'popular' && (
        <PopularPanel guildMembers={guildMembers} memberStatus={memberStatus} />
      )}
      {tab === 'upcoming' && <UpcomingPanel />}
    </div>
  );
}

function GuildHeader({ guild }: { guild: GuildMembershipSummary }) {
  const countLine = formatMemberCount(guild);
  return (
    <div className="flex items-center gap-3">
      <GuildAvatar guild={guild} size="lg" />
      <div className="min-w-0">
        <div className="text-base font-semibold text-gray-100 truncate">{guild.guildName}</div>
        {countLine && (
          <div className="text-[11px] text-gray-500 mt-0.5">{countLine}</div>
        )}
      </div>
    </div>
  );
}

function GuildTabs({
  active,
  onChange,
}: {
  active: GuildTab;
  onChange: (next: GuildTab) => void;
}) {
  const tabs: Array<{ id: GuildTab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'members', label: 'Members' },
    { id: 'popular', label: 'Popular wants' },
    { id: 'upcoming', label: 'Upcoming' },
  ];
  return (
    <div
      className="flex gap-1.5 overflow-x-auto -mx-1 px-1 border-b border-space-800 pb-2"
      role="tablist"
      aria-label="Community sections"
    >
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 h-8 rounded-md text-xs font-semibold shrink-0 transition-colors ${
            active === t.id
              ? 'bg-gold/20 border border-gold/50 text-gold'
              : 'bg-transparent border border-transparent text-gray-400 hover:text-gold hover:bg-space-800/60'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// --- Overview --------------------------------------------------------------

function OverviewPanel({
  guild,
  navigate,
  memberStatus,
  guildMembers,
}: {
  guild: GuildMembershipSummary;
  navigate: (r: Route) => void;
  memberStatus: 'loading' | 'ready' | 'error';
  guildMembers: MemberWithOverlap[];
}) {
  // Top 3 by total overlap — links into Members for the full list.
  // We re-sort here (rather than reusing sortedMembers) because
  // Overview is always overlap-ranked regardless of the Members tab's
  // sort selection.
  const topThree = useMemo(
    () => sortMembers(guildMembers, 'overlap').slice(0, 3),
    [guildMembers],
  );

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="overview-activity-heading">
        <h3
          id="overview-activity-heading"
          className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold mb-2"
        >
          Activity
        </h3>
        <div className="rounded-lg bg-space-800/40 border border-space-700 px-4 py-5 text-xs text-gray-500 leading-relaxed">
          Community activity coming soon — we'll surface new enrollments,
          fresh wants, and notable trades from {guild.guildName} here.
        </div>
      </section>

      <section aria-labelledby="overview-matches-heading">
        <div className="flex items-baseline justify-between mb-2">
          <h3
            id="overview-matches-heading"
            className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold"
          >
            Your matches here
          </h3>
          {guildMembers.length > topThree.length && (
            <button
              type="button"
              onClick={() => navigate({ guildId: guild.guildId, tab: 'members' })}
              className="text-[11px] text-gold hover:underline font-semibold"
            >
              See all {guildMembers.length} members →
            </button>
          )}
        </div>
        {memberStatus === 'loading' && <LoadingState label="Loading members…" />}
        {memberStatus === 'error' && (
          <ErrorState>Couldn't load members. Try refreshing.</ErrorState>
        )}
        {memberStatus === 'ready' && topThree.length === 0 && (
          <EmptyState title="No members to show yet.">
            Members appear here when they've enrolled in {guild.guildName} and
            opted into who-has queries. Check back as the community grows.
          </EmptyState>
        )}
        {topThree.length > 0 && (
          <ul className="flex flex-col gap-3">
            {topThree.map(m => (
              <MemberRow key={m.userId} member={m} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// --- Members ---------------------------------------------------------------

function MembersPanel({
  memberStatus,
  guildMembers,
  sortedMembers,
  sort,
  onSortChange,
}: {
  memberStatus: 'loading' | 'ready' | 'error';
  guildMembers: MemberWithOverlap[];
  sortedMembers: MemberWithOverlap[];
  sort: SortMode;
  onSortChange: (s: SortMode) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {memberStatus === 'loading' && <LoadingState label="Loading members…" />}
      {memberStatus === 'error' && (
        <ErrorState>Couldn't load the community directory. Try refreshing.</ErrorState>
      )}
      {memberStatus === 'ready' && guildMembers.length === 0 && (
        <EmptyState title="No one to trade with yet.">
          Members appear here when they've enrolled and opted into who-has
          queries. You also have to have who-has on for yourself — check{' '}
          <a href="/?settings=1&tab=servers" className="text-gold hover:underline font-semibold">
            Settings → Discord servers
          </a>{' '}
          if you're not sure.
        </EmptyState>
      )}
      {guildMembers.length > 0 && (
        <>
          <SortTabs sort={sort} onChange={onSortChange} />
          <ul className="flex flex-col gap-3">
            {sortedMembers.map(m => (
              <MemberRow key={m.userId} member={m} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SortTabs({ sort, onChange }: { sort: SortMode; onChange: (s: SortMode) => void }) {
  const tabs: Array<{ id: SortMode; label: string }> = [
    { id: 'overlap', label: 'Best overlap' },
    { id: 'offer', label: 'I can offer' },
    { id: 'receive', label: 'They have' },
    { id: 'alpha', label: 'A–Z' },
  ];
  return (
    <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1" role="tablist" aria-label="Sort members">
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={sort === t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 h-7 rounded-full text-[11px] font-semibold tracking-wide uppercase shrink-0 transition-colors ${
            sort === t.id
              ? 'bg-gold/20 border border-gold/50 text-gold'
              : 'bg-space-800/60 border border-space-700 text-gray-400 hover:text-gold hover:border-gold/30'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// --- Popular wants ---------------------------------------------------------

function PopularPanel({
  guildMembers,
  memberStatus,
}: {
  guildMembers: MemberWithOverlap[];
  memberStatus: 'loading' | 'ready' | 'error';
}) {
  // Aggregate familyId counts across this guild's members. The
  // /api/me/community rollup endpoint exists but returns only distinct
  // familyIds — no counts. The members directory already carries each
  // member's wantFamilyIds (gated on wantsPublic), so we can count
  // here without adding an endpoint.
  const top = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of guildMembers) {
      for (const fid of m.wantFamilyIds) {
        counts.set(fid, (counts.get(fid) ?? 0) + 1);
      }
    }
    const ranked = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10);
    return ranked;
  }, [guildMembers]);

  if (memberStatus === 'loading') return <LoadingState label="Loading popular wants…" />;
  if (memberStatus === 'error') {
    return <ErrorState>Couldn't load popular wants. Try refreshing.</ErrorState>;
  }
  if (top.length === 0) {
    return (
      <EmptyState title="No popular wants yet.">
        Members' public wants appear here once they start adding to their
        wants lists. Check back once the community has more activity.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Cards the most members of this community want. Counts reflect public
        wants only — members whose lists are private aren't included.
      </p>
      <ul className="flex flex-col gap-1.5">
        {top.map(([familyId, count], i) => (
          <li
            key={familyId}
            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-space-800/40 border border-space-700"
          >
            <span className="text-[11px] tracking-wider text-gray-500 font-mono w-5 shrink-0">
              {i + 1}
            </span>
            <span className="flex-1 min-w-0 text-sm text-gray-100 truncate">
              {familyIdToLabel(familyId)}
            </span>
            <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gold/15 border border-gold/40 text-[11px] text-gold font-semibold">
              {count} {count === 1 ? 'want' : 'wants'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Lightweight familyId → human label: families look like
 *  `set-slug::card-slug`. We only have the id here (no card lookup by
 *  family), so we prettify the slug rather than leave it machine-
 *  readable. Good enough for the list chrome; we can upgrade to a
 *  card-resolved label when we add a familyId → card index. */
function familyIdToLabel(familyId: string): string {
  const [setSlug, cardSlug] = familyId.split('::');
  const label = (cardSlug ?? familyId)
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
  if (!setSlug) return label;
  const setLabel = setSlug
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
  return `${label} · ${setLabel}`;
}

// --- Upcoming --------------------------------------------------------------

function UpcomingPanel() {
  return (
    <div className="rounded-lg bg-space-800/30 border border-dashed border-space-700 px-4 py-6 text-xs text-gray-500 leading-relaxed">
      <div className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold mb-2">
        Local game stores
      </div>
      <p className="opacity-80">
        Local game store integration coming soon — Phase 4 v2. We'll surface
        nearby LGS trade nights, meetups, and store-hosted events here.
      </p>
    </div>
  );
}

// --- Member row (shared between Overview + Members) ------------------------

function MemberRow({ member }: { member: MemberWithOverlap }) {
  const {
    handle, username, avatarUrl, mutualGuildNames, mutualGuildIds,
    iCanOfferThem, theyCanOfferMe, wantsTotal, availableTotal,
  } = member;
  const profileHref = `/u/${encodeURIComponent(handle)}`;
  const hasOverlap = iCanOfferThem + theyCanOfferMe > 0;
  const hasOverride = hasAnyPeerOverride(member);
  // Deep-link to the Settings member-prefs detail, scoped to the
  // first mutual guild — that's the most relevant "community context"
  // for the viewer landing on this member. Overrides apply globally,
  // so the choice of guild is cosmetic.
  const prefsHref = mutualGuildIds.length > 0
    ? `/?settings=1&tab=servers&guild=${encodeURIComponent(mutualGuildIds[0])}&members=1&user=${encodeURIComponent(member.userId)}`
    : null;

  return (
    <li
      className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
        hasOverlap
          ? 'bg-emerald-500/5 border-emerald-500/30 hover:border-emerald-400/60'
          : 'bg-space-800/40 border-space-700 hover:border-gold/30'
      }`}
    >
      <a href={profileHref} className="flex items-start gap-3 flex-1 min-w-0">
        <Avatar avatarUrl={avatarUrl} username={username} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-100 truncate">@{handle}</span>
            {username !== handle && (
              <span className="text-[11px] text-gray-500 truncate">{username}</span>
            )}
            {hasOverride && (
              <span className="text-[10px] tracking-wide uppercase text-gold font-bold">
                Prefs set
              </span>
            )}
          </div>
          {mutualGuildNames.length > 0 && (
            <div className="text-[11px] text-gray-500 mt-0.5 truncate">
              {mutualGuildNames.join(' · ')}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            <OverlapChip
              label="You can offer"
              count={iCanOfferThem}
              total={wantsTotal}
              tone="emerald"
            />
            <OverlapChip
              label="They have for you"
              count={theyCanOfferMe}
              total={availableTotal}
              tone="blue"
            />
          </div>
        </div>
      </a>
      {prefsHref && (
        <a
          href={prefsHref}
          className="shrink-0 self-start text-[10px] tracking-wide uppercase text-gray-500 hover:text-gold font-semibold py-1 px-2 rounded-md border border-space-700 hover:border-gold/40 transition-colors"
          title="Manage per-trader preferences in Settings"
        >
          Prefs
        </a>
      )}
    </li>
  );
}

function hasAnyPeerOverride(m: CommunityMember): boolean {
  return Object.values(m.peerPrefs.override).some(v => v !== null);
}

function OverlapChip({ label, count, total, tone }: {
  label: string;
  count: number;
  total: number;
  tone: 'emerald' | 'blue';
}) {
  const active = count > 0;
  const activeTone = tone === 'emerald'
    ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200'
    : 'bg-blue-500/15 border-blue-400/40 text-blue-200';
  const dimTone = 'bg-space-800/60 border-space-700 text-gray-500';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] ${active ? activeTone : dimTone}`}>
      <span className="font-semibold">{count}</span>
      <span className="font-normal opacity-80">of {total}</span>
      <span className="opacity-60">· {label}</span>
    </span>
  );
}

function Avatar({ avatarUrl, username }: { avatarUrl: string | null; username: string }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="w-10 h-10 rounded-full shrink-0" />;
  }
  const initial = username.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className="w-10 h-10 rounded-full bg-space-700 text-gold font-bold flex items-center justify-center shrink-0 text-sm"
    >
      {initial}
    </span>
  );
}

function GuildAvatar({ guild, size = 'md' }: { guild: GuildMembershipSummary; size?: 'md' | 'lg' }) {
  const dim = size === 'lg' ? 'w-10 h-10 text-sm' : 'w-8 h-8 text-xs';
  const initial = guild.guildName.trim().slice(0, 1).toUpperCase() || '?';
  if (guild.guildIcon) {
    const url = `https://cdn.discordapp.com/icons/${guild.guildId}/${guild.guildIcon}.png?size=64`;
    return <img src={url} alt="" className={`${dim} rounded-full shrink-0`} />;
  }
  return (
    <span
      aria-hidden
      className={`${dim} rounded-full bg-space-700 text-gold font-bold flex items-center justify-center shrink-0`}
    >
      {initial}
    </span>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

// --- Helpers ---------------------------------------------------------------

/** Compose the "N members active" stat under each guild's header.
 *  The task calls for graceful handling when `memberCount` isn't on
 *  the type yet (sibling P3 work); defensive typeof check keeps the
 *  component compatible either way. Returns empty string when we
 *  have nothing meaningful to display so callers can conditionally
 *  render. */
function formatMemberCount(guild: GuildMembershipSummary): string {
  const maybe = (guild as { memberCount?: unknown }).memberCount;
  if (typeof maybe !== 'number') return '';
  if (maybe === 1) return '1 member';
  return `${maybe} members`;
}

function enrichMember(
  m: CommunityMember,
  viewerAvailableFamilies: Set<string>,
  viewerWantFamilies: Set<string>,
  byProductId: Map<string, CardVariant>,
): MemberWithOverlap {
  let iCanOfferThem = 0;
  for (const fid of m.wantFamilyIds) {
    if (viewerAvailableFamilies.has(fid)) iCanOfferThem++;
  }
  const theirAvailableFamilies = new Set<string>();
  for (const pid of m.availableProductIds) {
    const card = byProductId.get(pid);
    if (card) theirAvailableFamilies.add(cardFamilyId(card));
  }
  let theyCanOfferMe = 0;
  for (const fid of theirAvailableFamilies) {
    if (viewerWantFamilies.has(fid)) theyCanOfferMe++;
  }
  return {
    ...m,
    iCanOfferThem,
    theyCanOfferMe,
    totalOverlap: iCanOfferThem + theyCanOfferMe,
  };
}

function sortMembers(members: MemberWithOverlap[], sort: SortMode): MemberWithOverlap[] {
  const copy = [...members];
  copy.sort((a, b) => {
    switch (sort) {
      case 'offer':
        return b.iCanOfferThem - a.iCanOfferThem || b.totalOverlap - a.totalOverlap;
      case 'receive':
        return b.theyCanOfferMe - a.theyCanOfferMe || b.totalOverlap - a.totalOverlap;
      case 'alpha':
        return a.handle.localeCompare(b.handle);
      case 'overlap':
      default:
        return b.totalOverlap - a.totalOverlap || a.handle.localeCompare(b.handle);
    }
  });
  return copy;
}
