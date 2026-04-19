import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from './ui/PageHeader';
import { LoadingState, EmptyState } from './ui/states';
import {
  useAccountSettings,
  type AccountSettingsApi,
  type PrefValue,
} from '../hooks/useAccountSettings';
import {
  useGuildMemberships,
  type GuildMembershipSummary,
} from '../hooks/useGuildMemberships';
import {
  useCommunityMembers,
  type CommunityMember,
  type CommunityMembersApi,
} from '../hooks/useCommunityMembers';
import { useAuthContext } from '../contexts/AuthContext';
import { PREF_DEFINITIONS, type PrefDefinition } from '../../lib/prefsRegistry';

interface SettingsViewProps {
  onClose: () => void;
}

/**
 * Full-page `/?settings=1` — a Slack-mobile-style hub + drill-down.
 *
 * Routing shape (query-param driven, bookmarkable, back-button
 * friendly via native `popstate`):
 *
 *   /?settings=1                                               — hub
 *   /?settings=1&tab=profile                                   — identity
 *   /?settings=1&tab=preferences                               — global prefs
 *   /?settings=1&tab=servers                                   — guild list
 *   /?settings=1&tab=servers&guild=<id>                        — one server
 *   /?settings=1&tab=servers&guild=<id>&members                — member list
 *   /?settings=1&tab=servers&guild=<id>&members&user=<id>      — per-user prefs
 *
 * The peer-prefs editor lives under `servers/<guild>/members/<user>` —
 * a navigation affordance, not a storage model (peer overrides remain
 * globally-scoped in the DB; the UI just surfaces them in a community
 * context so users can find them from wherever they ran into the peer).
 */
export function SettingsView({ onClose }: SettingsViewProps) {
  const account = useAccountSettings();
  const guilds = useGuildMemberships();
  const community = useCommunityMembers();
  const auth = useAuthContext();

  const [route, setRoute] = useState<Route>(() => parseRoute());

  // Keep the in-view state in sync with the browser URL on back/forward.
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

  const parent = useMemo(() => parentRoute(route), [route]);
  const onBack = useCallback(() => {
    if (parent == null) onClose();
    else navigate(parent);
  }, [parent, onClose, navigate]);

  // Compute kicker + content per route. Each sub-view renders inside
  // the same chrome; the only variable is which component + kicker.
  let kicker = 'Settings';
  let content: React.ReactNode;

  if (route.tab == null) {
    content = <SettingsHub auth={auth} guilds={guilds} navigate={navigate} />;
  } else if (route.tab === 'profile') {
    kicker = 'Profile';
    content = <ProfileSection account={account} handle={auth.user?.handle ?? null} />;
  } else if (route.tab === 'preferences') {
    kicker = 'Preferences';
    content = <PreferencesSection account={account} />;
  } else if (route.tab === 'servers' && !route.guildId) {
    kicker = 'Discord servers';
    content = <ServersHub guilds={guilds} botInstallUrl={auth.botInstallUrl} navigate={navigate} />;
  } else if (route.tab === 'servers' && route.guildId && !route.members) {
    const guild = guilds.enrollable.find(g => g.guildId === route.guildId);
    kicker = guild?.guildName ?? 'Server';
    content = (
      <ServerDetail
        guild={guild ?? null}
        onChange={patch => route.guildId && guilds.updateGuild(route.guildId, patch)}
        navigate={navigate}
      />
    );
  } else if (route.tab === 'servers' && route.guildId && route.members && !route.userId) {
    const guild = guilds.enrollable.find(g => g.guildId === route.guildId);
    kicker = guild ? `${guild.guildName} · Members` : 'Members';
    content = (
      <GuildMembersList
        guildId={route.guildId}
        community={community}
        navigate={navigate}
      />
    );
  } else if (route.tab === 'servers' && route.guildId && route.members && route.userId) {
    const member = community.members.find(m => m.userId === route.userId);
    kicker = member ? `@${member.handle}` : 'Member';
    content = (
      <MemberPrefsDetail
        member={member ?? null}
        setPeerPref={community.setPeerPref}
      />
    );
  } else {
    // Unknown tab — treat as hub. Replaces the URL so forward/back don't
    // park on a dead route.
    content = <SettingsHub auth={auth} guilds={guilds} navigate={navigate} />;
  }

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <div className="px-3 sm:px-6 pt-3 pb-2 max-w-3xl mx-auto w-full">
        <PageHeader onBack={onBack} kicker={kicker} />
      </div>

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-2 max-w-3xl mx-auto w-full">
        {content}
      </main>
    </div>
  );
}

// --- Routing ---------------------------------------------------------------

interface Route {
  tab?: 'profile' | 'preferences' | 'servers';
  guildId?: string;
  members?: boolean;
  userId?: string;
}

function parseRoute(): Route {
  if (typeof window === 'undefined') return {};
  const p = new URLSearchParams(window.location.search);
  const rawTab = p.get('tab');
  const tab = rawTab === 'profile' || rawTab === 'preferences' || rawTab === 'servers'
    ? rawTab
    : undefined;
  return {
    tab,
    guildId: p.get('guild') ?? undefined,
    members: p.has('members') || undefined,
    userId: p.get('user') ?? undefined,
  };
}

function buildUrl(route: Route): string {
  const p = new URLSearchParams(window.location.search);
  // Strip anything this function owns so we don't leak state between drill-ins.
  for (const key of ['tab', 'guild', 'members', 'user']) p.delete(key);
  p.set('settings', '1');
  if (route.tab) p.set('tab', route.tab);
  if (route.guildId) p.set('guild', route.guildId);
  if (route.members) p.set('members', '1');
  if (route.userId) p.set('user', route.userId);
  return `${window.location.pathname}?${p.toString()}`;
}

/** Returns the parent route for the "back" button. `null` means "exit
 *  to the main app" (invokes onClose). */
function parentRoute(route: Route): Route | null {
  if (route.tab == null) return null;
  if (route.tab === 'servers' && route.guildId && route.members && route.userId) {
    return { tab: 'servers', guildId: route.guildId, members: true };
  }
  if (route.tab === 'servers' && route.guildId && route.members) {
    return { tab: 'servers', guildId: route.guildId };
  }
  if (route.tab === 'servers' && route.guildId) {
    return { tab: 'servers' };
  }
  return {};
}

// --- Hub -------------------------------------------------------------------

function SettingsHub({
  auth,
  guilds,
  navigate,
}: {
  auth: ReturnType<typeof useAuthContext>;
  guilds: ReturnType<typeof useGuildMemberships>;
  navigate: (r: Route) => void;
}) {
  const enrolledCount = guilds.enrollable.filter(g => g.enrolled).length;
  const totalServers = guilds.enrollable.length;

  return (
    <div className="mt-4">
      {auth.user && <IdentityCard user={auth.user} />}
      <div className="mt-6 flex flex-col gap-1">
        <HubRow
          label="Profile"
          description="Handle, visibility, your public share URL"
          onClick={() => navigate({ tab: 'profile' })}
        />
        <HubRow
          label="Preferences"
          description="Thread behavior + bot notifications"
          onClick={() => navigate({ tab: 'preferences' })}
        />
        <HubRow
          label="Discord servers"
          description={totalServers === 0
            ? 'No enrollable servers yet'
            : `${enrolledCount} enrolled · ${totalServers} available`}
          onClick={() => navigate({ tab: 'servers' })}
        />
      </div>
    </div>
  );
}

function IdentityCard({ user }: { user: { handle: string; username?: string | null; avatarUrl?: string | null } }) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-lg bg-space-800/40 border border-space-700">
      <Avatar avatarUrl={user.avatarUrl ?? null} name={user.username ?? user.handle} />
      <div className="min-w-0">
        <div className="text-sm font-semibold text-gray-100 truncate">
          {user.username && user.username !== user.handle ? user.username : `@${user.handle}`}
        </div>
        {user.username && user.username !== user.handle && (
          <div className="text-[11px] text-gray-500 truncate">@{user.handle}</div>
        )}
      </div>
    </div>
  );
}

function HubRow({
  label,
  description,
  onClick,
  disabled,
}: {
  label: string;
  description?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-space-800/40 border border-space-700 transition-colors text-left ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-gold/40 hover:bg-space-800/60'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-gray-100">{label}</div>
        {description && (
          <div className="text-[11px] text-gray-500 mt-0.5 truncate">{description}</div>
        )}
      </div>
      <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
    </button>
  );
}

// --- Profile section -------------------------------------------------------

function ProfileSection({
  account,
  handle,
}: {
  account: AccountSettingsApi;
  handle: string | null;
}) {
  const { settings, status, update } = account;
  const profileVisibility = PREF_DEFINITIONS.find(
    d => d.key === 'profileVisibility' && d.scope.kind === 'self',
  );

  return (
    <div className="mt-4 flex flex-col gap-6">
      {status === 'loading' && <LoadingState />}
      {status === 'error' && !settings && (
        <ErrorLine>Couldn't load your settings. Try refreshing.</ErrorLine>
      )}

      {settings && profileVisibility && (
        <PrefField
          def={profileVisibility}
          value={settings[profileVisibility.key] ?? (profileVisibility.default as PrefValue)}
          onChange={next => update({ [profileVisibility.key]: next })}
        />
      )}

      {handle && <PublicProfileBlock handle={handle} />}
    </div>
  );
}

function PublicProfileBlock({ handle }: { handle: string }) {
  const [copied, setCopied] = useState(false);
  const path = `/u/${handle}`;
  const url = typeof window !== 'undefined' ? `${window.location.origin}${path}` : path;
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard can fail in insecure contexts */ }
  };

  return (
    <section aria-labelledby="public-profile-heading">
      <h2
        id="public-profile-heading"
        className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold mb-2"
      >
        Your public profile
      </h2>
      <p className="text-xs text-gray-500 leading-relaxed mb-3">
        Share this link so other traders can see your wants and available lists
        (subject to your visibility setting above).
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          readOnly
          value={url}
          aria-label="Public profile URL"
          onFocus={e => e.target.select()}
          className="flex-1 min-w-0 bg-space-800 border border-space-700 text-gray-300 text-xs rounded-lg px-3 py-2 font-mono focus:border-gold/50 focus:outline-none"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="px-3 py-2 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-300 hover:text-gold"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a
            href={path}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-2 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-300 hover:text-gold"
          >
            Preview
          </a>
        </div>
      </div>
    </section>
  );
}

// --- Preferences section ---------------------------------------------------

function PreferencesSection({ account }: { account: AccountSettingsApi }) {
  const { settings, status, update } = account;

  // Render every self-scoped, web-surfaced, non-privacy pref. Privacy
  // lives under Profile (where profileVisibility has its natural home).
  const defs = PREF_DEFINITIONS.filter(
    d => d.scope.kind === 'self'
      && d.surfaces.includes('web')
      && d.section !== 'privacy',
  );

  // Group by section — section labels drive the visible headings.
  const bySection = new Map<string, PrefDefinition[]>();
  for (const def of defs) {
    const key = def.section ?? 'communication';
    const list = bySection.get(key) ?? [];
    list.push(def);
    bySection.set(key, list);
  }

  const sections: Array<{ id: 'communication' | 'notifications'; label: string; description?: string }> = [
    {
      id: 'communication',
      label: 'Communication',
      description: 'How SWUTrade routes Discord conversation for trade proposals.',
    },
    {
      id: 'notifications',
      label: 'Bot notifications',
      description: "Discord DMs SWUTrade's bot will send you. Trade proposals sent directly to you are separate from broadcast alerts.",
    },
  ];

  return (
    <div className="mt-4 flex flex-col gap-6">
      {status === 'loading' && <LoadingState />}
      {status === 'error' && !settings && (
        <ErrorLine>Couldn't load your settings. Try refreshing.</ErrorLine>
      )}

      {settings && sections.map(section => {
        const sectionDefs = bySection.get(section.id);
        if (!sectionDefs?.length) return null;
        return (
          <fieldset key={section.id} className="flex flex-col gap-2">
            <legend className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold pb-1">
              {section.label}
            </legend>
            {section.description && (
              <p className="text-[11px] text-gray-500 leading-relaxed -mt-1 mb-1">
                {section.description}
              </p>
            )}
            {sectionDefs.map(def => (
              <PrefField
                key={def.key}
                def={def}
                value={settings[def.key] ?? (def.default as PrefValue)}
                onChange={next => update({ [def.key]: next })}
              />
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

// --- Servers hub -----------------------------------------------------------

function ServersHub({
  guilds,
  botInstallUrl,
  navigate,
}: {
  guilds: ReturnType<typeof useGuildMemberships>;
  botInstallUrl: string | null;
  navigate: (r: Route) => void;
}) {
  const { enrollable, status, refreshStatus, refreshFromDiscord } = guilds;
  const refreshBusy = refreshStatus === 'refreshing';

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500 leading-relaxed flex-1">
          Enroll in a server to join its trading community — your wants +
          available lists become visible to members, and you get matched against
          theirs. Enrollment is per-server and optional.
        </p>
        <button
          type="button"
          onClick={() => { void refreshFromDiscord(); }}
          disabled={refreshBusy}
          className="ml-3 flex items-center gap-1.5 px-2.5 h-7 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-[11px] font-medium text-gray-400 hover:text-gold disabled:opacity-50 disabled:cursor-wait shrink-0"
        >
          <RefreshIcon className={`w-3 h-3 ${refreshBusy ? 'animate-spin' : ''}`} />
          {refreshBusy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {refreshStatus === 'needs-reauth' && <ReauthBanner />}
      {refreshStatus === 'error' && (
        <ErrorLine>Couldn't refresh from Discord. Try again in a moment.</ErrorLine>
      )}

      {status === 'loading' && <LoadingState />}
      {status === 'error' && enrollable.length === 0 && (
        <ErrorLine>Couldn't load your Discord memberships. Try refreshing.</ErrorLine>
      )}

      {status !== 'loading' && enrollable.length === 0 && (
        <div className="rounded-lg bg-space-800/40 border border-space-700 px-3 py-3 text-[11px] text-gray-500 leading-relaxed">
          SWUTrade's bot isn't installed in any of your Discord servers yet.
          Once a server admin installs it, that server will appear here as
          enrollable.
        </div>
      )}

      {enrollable.length > 0 && (
        <div className="flex flex-col gap-1">
          {enrollable.map(g => (
            <GuildRow
              key={g.guildId}
              guild={g}
              onClick={() => navigate({ tab: 'servers', guildId: g.guildId })}
            />
          ))}
        </div>
      )}

      <InviteBotBlock botInstallUrl={botInstallUrl} />
    </div>
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
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left ${
        guild.enrolled
          ? 'bg-gold/5 border-gold/40 hover:border-gold/60'
          : 'bg-space-800/40 border-space-700 hover:border-gold/30'
      }`}
    >
      <GuildAvatar guild={guild} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-100 truncate">{guild.guildName}</div>
        <div className="text-[11px] text-gray-500 mt-0.5">
          {guild.enrolled ? 'Enrolled' : 'Not enrolled'}
          {guild.canManage && ' · You manage this server'}
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
    </button>
  );
}

// --- Server detail ---------------------------------------------------------

function ServerDetail({
  guild,
  onChange,
  navigate,
}: {
  guild: GuildMembershipSummary | null;
  onChange: (patch: Partial<Pick<GuildMembershipSummary, 'enrolled' | 'includeInRollups' | 'appearInQueries'>>) => void;
  navigate: (r: Route) => void;
}) {
  if (!guild) {
    return (
      <EmptyState title="Server not found.">
        The server you're looking at may have been removed, or SWUTrade's bot
        may no longer be installed. Try refreshing the server list.
      </EmptyState>
    );
  }
  return (
    <div className="mt-4 flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <GuildAvatar guild={guild} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-100 truncate">{guild.guildName}</div>
          {guild.canManage && (
            <div className="text-[10px] tracking-wider uppercase text-gold/70 font-bold">
              You manage this server
            </div>
          )}
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold pb-1">
          Enrollment
        </legend>
        <ToggleField
          label={`Enroll in ${guild.guildName}`}
          hint="Turning this on makes your lists discoverable here and lets you match against members' wants + available."
          value={guild.enrolled}
          onChange={v => onChange({ enrolled: v })}
        />
        {guild.enrolled && (
          <>
            <ToggleField
              label="Include in community rollups"
              hint="Your wants + available show up in this server's aggregated community data."
              value={guild.includeInRollups}
              onChange={v => onChange({ includeInRollups: v })}
            />
            <ToggleField
              label="Appear in who-has queries"
              hint="You show up when members run a card lookup for this server."
              value={guild.appearInQueries}
              onChange={v => onChange({ appearInQueries: v })}
            />
          </>
        )}
      </fieldset>

      {guild.enrolled && (
        <div>
          <HubRow
            label="Members"
            description="Set per-trader preferences for individual members of this server"
            onClick={() => navigate({ tab: 'servers', guildId: guild.guildId, members: true })}
          />
        </div>
      )}
    </div>
  );
}

// --- Members list ----------------------------------------------------------

function GuildMembersList({
  guildId,
  community,
  navigate,
}: {
  guildId: string;
  community: CommunityMembersApi;
  navigate: (r: Route) => void;
}) {
  const { members, status } = community;

  const filtered = useMemo(() => {
    const inGuild = members.filter(m => m.mutualGuildIds.includes(guildId));
    return [...inGuild].sort((a, b) => {
      const aHas = hasAnyOverride(a);
      const bHas = hasAnyOverride(b);
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.handle.localeCompare(b.handle);
    });
  }, [members, guildId]);

  return (
    <div className="mt-4 flex flex-col gap-3">
      {status === 'loading' && <LoadingState label="Loading members…" />}
      {status === 'ready' && filtered.length === 0 && (
        <EmptyState title="No members to show for this server.">
          Members appear here when they've enrolled and opted into who-has
          queries. Your enrollment settings also have to include who-has on
          your end.
        </EmptyState>
      )}
      {filtered.length > 0 && (
        <>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            Members you've set overrides for appear first. Tap a member to
            change their per-trader preferences.
          </p>
          <ul className="flex flex-col gap-1">
            {filtered.map(m => (
              <MemberListRow
                key={m.userId}
                member={m}
                onClick={() => navigate({
                  tab: 'servers',
                  guildId,
                  members: true,
                  userId: m.userId,
                })}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function MemberListRow({
  member,
  onClick,
}: {
  member: CommunityMember;
  onClick: () => void;
}) {
  const configured = hasAnyOverride(member);
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left ${
          configured
            ? 'bg-gold/5 border-gold/40 hover:border-gold/60'
            : 'bg-space-800/40 border-space-700 hover:border-gold/30'
        }`}
      >
        <Avatar avatarUrl={member.avatarUrl} name={member.username || member.handle} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-gray-100 truncate">@{member.handle}</span>
            {configured && (
              <span className="text-[10px] tracking-wide uppercase text-gold font-bold">
                Configured
              </span>
            )}
          </div>
          {member.username && member.username !== member.handle && (
            <div className="text-[11px] text-gray-500 truncate">{member.username}</div>
          )}
        </div>
        <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
      </button>
    </li>
  );
}

// --- Member prefs detail ---------------------------------------------------

function MemberPrefsDetail({
  member,
  setPeerPref,
}: {
  member: CommunityMember | null;
  setPeerPref: CommunityMembersApi['setPeerPref'];
}) {
  if (!member) {
    return (
      <EmptyState title="Member not found.">
        This member may have left every server you share with them, or you may
        have landed on a stale link. Back out to the members list.
      </EmptyState>
    );
  }

  const peerDefs = PREF_DEFINITIONS.filter(
    d => d.scope.kind === 'peer' && d.surfaces.includes('web'),
  );

  return (
    <div className="mt-4 flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Avatar avatarUrl={member.avatarUrl} name={member.username || member.handle} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-100 truncate">@{member.handle}</div>
          {member.username && member.username !== member.handle && (
            <div className="text-[11px] text-gray-500 truncate">{member.username}</div>
          )}
        </div>
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Overrides for @{member.handle} apply wherever you cross paths — they're
        not scoped to this server specifically.
      </p>

      <div className="flex flex-col gap-4">
        {peerDefs.map(def => (
          <PeerPrefField
            key={def.key}
            def={def}
            override={member.peerPrefs.override[def.key] ?? null}
            effective={member.peerPrefs.effective[def.key] ?? null}
            onChange={value => { void setPeerPref(member.userId, def.key, value); }}
          />
        ))}
        {peerDefs.length === 0 && (
          <EmptyState title="No per-trader preferences available yet.">
            Your global defaults apply to every trader.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function PeerPrefField({
  def,
  override,
  effective,
  onChange,
}: {
  def: PrefDefinition;
  override: PrefValue | null;
  effective: PrefValue | null;
  onChange: (value: PrefValue | null) => void;
}) {
  if (def.type.kind !== 'enum') return null;
  const id = `peer-pref-${def.key}`;
  const currentValue = override == null ? '' : String(override);
  const effectiveLabel = def.type.options.find(o => o.value === effective)?.label ?? String(effective ?? '');
  const hasOverride = override != null;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">
        {def.label}
      </label>
      <p className="text-[11px] text-gray-500 leading-relaxed">
        {def.description}
      </p>
      <select
        id={id}
        value={currentValue}
        onChange={e => {
          const v = e.target.value;
          onChange(v === '' ? null : v);
        }}
        className={`w-full sm:w-auto border text-sm rounded-lg px-3 py-2 focus:outline-none transition-colors ${
          hasOverride
            ? 'bg-space-800 border-gold/50 text-gold focus:border-gold/70'
            : 'bg-space-800 border-space-700 text-gray-100 focus:border-gold/50'
        }`}
      >
        <option value="">{`Use my default (${effectiveLabel})`}</option>
        {def.type.options.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.description ? `${opt.label} — ${opt.description}` : opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// --- Shared pref renderers -------------------------------------------------

function PrefField({
  def,
  value,
  onChange,
}: {
  def: PrefDefinition;
  value: PrefValue;
  onChange: (next: PrefValue) => void;
}) {
  if (def.type.kind === 'boolean') {
    return (
      <ToggleField
        label={def.label}
        hint={def.description}
        value={value as boolean}
        onChange={onChange}
      />
    );
  }
  return (
    <EnumSelectField
      def={def}
      value={value as string}
      onChange={onChange}
    />
  );
}

function EnumSelectField({
  def,
  value,
  onChange,
}: {
  def: PrefDefinition;
  value: string;
  onChange: (next: string) => void;
}) {
  if (def.type.kind !== 'enum') return null;
  const id = `pref-${def.key}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold" htmlFor={id}>
        {def.label}
      </label>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full sm:w-auto bg-space-800 border border-space-700 text-gray-100 text-sm rounded-lg px-3 py-2 focus:border-gold/50 focus:outline-none"
      >
        {def.type.options.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.description ? `${opt.label} — ${opt.description}` : opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer py-1">
      <input
        type="checkbox"
        checked={value}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 rounded bg-space-800 border-space-700 text-gold accent-gold cursor-pointer"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-100">{label}</div>
        {hint && <div className="text-[11px] text-gray-500 leading-relaxed">{hint}</div>}
      </div>
    </label>
  );
}

// --- Shared UI -------------------------------------------------------------

function hasAnyOverride(m: CommunityMember): boolean {
  return Object.values(m.peerPrefs.override).some(v => v !== null);
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
  const dim = 'w-8 h-8 text-xs';
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

function ReauthBanner() {
  return (
    <div className="rounded-lg bg-amber-500/10 border border-amber-400/30 px-3 py-2.5 mb-1 text-[11px] text-amber-200 leading-relaxed">
      Your Discord session expired.{' '}
      <a href="/api/auth/discord" className="underline font-semibold hover:text-amber-100">
        Sign in again
      </a>{' '}
      to refresh your server list.
    </div>
  );
}

function InviteBotBlock({ botInstallUrl }: { botInstallUrl: string | null }) {
  return (
    <div className="rounded-lg bg-space-800/40 border border-space-700 px-3 py-3 text-[11px] text-gray-400 leading-relaxed">
      <div className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold mb-2">
        Want SWUTrade in another server?
      </div>
      <p className="mb-2">
        If you manage the server, you can invite the bot directly. If you
        don't, send the invite link to an admin and ask them to add it.
      </p>
      {botInstallUrl ? (
        <a
          href={botInstallUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#5865F2]/80 hover:bg-[#5865F2] text-white text-xs font-bold transition-colors"
        >
          Invite SWUTrade bot
          <ExternalIcon className="w-3 h-3" />
        </a>
      ) : (
        <span className="text-gray-500 italic">Invite link isn't configured yet.</span>
      )}
    </div>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-red-300 mb-1">{children}</div>;
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3v4h-4" />
      <path d="M13.5 11a5.5 5.5 0 1 1-1.3-6.5L14 7" />
    </svg>
  );
}

function ExternalIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3H3v10h10V10" />
      <path d="M10 2h4v4" />
      <path d="M14 2L8 8" />
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}
