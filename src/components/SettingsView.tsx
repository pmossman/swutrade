import { Logo } from './Logo';
import { BetaBadge } from './BetaBadge';
import {
  useAccountSettings,
  type ProfileVisibility,
} from '../hooks/useAccountSettings';
import {
  useGuildMemberships,
  type GuildMembershipSummary,
} from '../hooks/useGuildMemberships';

interface SettingsViewProps {
  onClose: () => void;
}

/**
 * Full-page /?settings=1 view. Reached from the account menu.
 * Two sections: Account (profile visibility + bot DM categories)
 * and Discord servers (enrollable vs. other guild cards). Saves
 * happen on change via the hooks' optimistic update helpers.
 */
export function SettingsView({ onClose }: SettingsViewProps) {
  const account = useAccountSettings();
  const guilds = useGuildMemberships();

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <header className="px-3 sm:px-6 pt-3 pb-2 max-w-3xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <h1 className="relative flex items-center select-none shrink-0">
            <Logo className="w-6 h-6 sm:w-7 sm:h-7 shrink-0" />
            <span className="ml-px text-sm sm:text-lg font-bold tracking-[0.1em] sm:tracking-[0.12em] leading-none">
              <span className="text-gray-200 uppercase">SWU</span><span className="text-gold uppercase">Trade</span>
            </span>
            <BetaBadge className="absolute bottom-0 left-7 sm:left-8 translate-y-[calc(100%-2px)]" />
          </h1>
          <div className="ml-auto">
            <button
              type="button"
              onClick={onClose}
              aria-label="Back"
              className="flex items-center gap-1 px-3 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-400 hover:text-gold"
            >
              <BackIcon className="w-3.5 h-3.5" />
              Back
            </button>
          </div>
        </div>
        <div className="mt-3">
          <span className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">Settings</span>
        </div>
      </header>

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-2 max-w-3xl mx-auto w-full">
        <AccountSection account={account} />
        <GuildsSection guilds={guilds} />
      </main>
    </div>
  );
}

// --- Account section --------------------------------------------------------

function AccountSection({ account }: { account: ReturnType<typeof useAccountSettings> }) {
  const { settings, status, update } = account;

  return (
    <section className="mt-6" aria-labelledby="account-heading">
      <h2 id="account-heading" className="text-xs sm:text-sm font-bold tracking-[0.18em] uppercase text-gold/80 pb-2 mb-3 border-b border-gold/20">
        Account
      </h2>

      {status === 'loading' && <LoadingLine />}
      {status === 'error' && !settings && (
        <ErrorLine>Couldn't load your settings. Try refreshing.</ErrorLine>
      )}

      {settings && (
        <div className="flex flex-col gap-5">
          <VisibilityField
            value={settings.profileVisibility}
            onChange={v => update({ profileVisibility: v })}
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold pb-1">
              Bot notifications
            </legend>
            <p className="text-[11px] text-gray-500 leading-relaxed -mt-1 mb-1">
              Discord DMs SWUTrade's bot will send you. Trade proposals sent directly
              to you are separate from broadcast alerts.
            </p>
            <ToggleField
              label="Trade proposals sent to me"
              hint="When another user proposes a trade with you specifically."
              value={settings.dmTradeProposals}
              onChange={v => update({ dmTradeProposals: v })}
            />
            <ToggleField
              label="Match alerts"
              hint="Unsolicited pings when someone's wants overlap with your available list."
              value={settings.dmMatchAlerts}
              onChange={v => update({ dmMatchAlerts: v })}
            />
            <ToggleField
              label="Meetup reminders"
              hint="Reminders for LGS visits you've announced."
              value={settings.dmMeetupReminders}
              onChange={v => update({ dmMeetupReminders: v })}
            />
          </fieldset>
        </div>
      )}
    </section>
  );
}

function VisibilityField({ value, onChange }: {
  value: ProfileVisibility;
  onChange: (next: ProfileVisibility) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold" htmlFor="profile-visibility">
        Profile visibility
      </label>
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Who can see your profile page and community rollups.
      </p>
      <select
        id="profile-visibility"
        value={value}
        onChange={e => onChange(e.target.value as ProfileVisibility)}
        className="w-full sm:w-auto bg-space-800 border border-space-700 text-gray-100 text-sm rounded-lg px-3 py-2 focus:border-gold/50 focus:outline-none"
      >
        <option value="public">Public — anyone with the URL</option>
        <option value="discord">Discord only — users in my enrolled servers</option>
        <option value="private">Private — only me</option>
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

// --- Guilds section ---------------------------------------------------------

function GuildsSection({ guilds }: { guilds: ReturnType<typeof useGuildMemberships> }) {
  const { enrollable, other, status, updateGuild } = guilds;

  return (
    <section className="mt-10" aria-labelledby="guilds-heading">
      <h2 id="guilds-heading" className="text-xs sm:text-sm font-bold tracking-[0.18em] uppercase text-gold/80 pb-2 mb-3 border-b border-gold/20">
        Discord servers
      </h2>
      <p className="text-xs text-gray-500 leading-relaxed mb-4">
        Enroll in a server to join its trading community — your wants and
        available lists become visible to members, and you get matched
        against their lists. You can enroll in multiple servers. Enrollment
        is optional; you can sign in without joining any community.
      </p>

      {status === 'loading' && <LoadingLine />}
      {status === 'error' && enrollable.length === 0 && other.length === 0 && (
        <ErrorLine>Couldn't load your Discord memberships. Try refreshing.</ErrorLine>
      )}

      {status !== 'loading' && enrollable.length === 0 && (
        <div className="rounded-lg bg-space-800/40 border border-space-700 px-3 py-3 text-[11px] text-gray-500 leading-relaxed mb-5">
          SWUTrade's bot isn't installed in any of your Discord servers yet.
          Once a server admin installs it, that server will appear here as
          enrollable.
        </div>
      )}

      {enrollable.length > 0 && (
        <div className="flex flex-col gap-3 mb-6">
          {enrollable.map(g => (
            <EnrollableGuildCard
              key={g.guildId}
              guild={g}
              onChange={patch => updateGuild(g.guildId, patch)}
            />
          ))}
        </div>
      )}

      {other.length > 0 && (
        <div>
          <div className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold pb-2">
            Other servers
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
            Servers you're a member of where SWUTrade isn't installed yet.
            If you manage one of these, you can invite the bot to unlock
            community features for everyone there.
          </p>
          <ul className="flex flex-col gap-1.5">
            {other.map(g => (
              <li
                key={g.guildId}
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-space-800/40 border border-space-700 text-sm text-gray-400"
              >
                <GuildAvatar guild={g} size="sm" />
                <span className="truncate flex-1">{g.guildName}</span>
                {g.canManage && (
                  <span className="text-[10px] tracking-wider uppercase text-gold/80 font-bold">
                    You manage this
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function EnrollableGuildCard({ guild, onChange }: {
  guild: GuildMembershipSummary;
  onChange: (patch: Partial<Pick<GuildMembershipSummary, 'enrolled' | 'includeInRollups' | 'appearInQueries'>>) => void;
}) {
  return (
    <div className={`rounded-lg border transition-colors ${
      guild.enrolled
        ? 'bg-gold/5 border-gold/40'
        : 'bg-space-800/40 border-space-700'
    }`}>
      <div className="flex items-center gap-3 px-3 py-3">
        <GuildAvatar guild={guild} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-100 font-semibold truncate">{guild.guildName}</div>
          {guild.canManage && (
            <div className="text-[10px] tracking-wider uppercase text-gold/70 font-bold">
              You manage this server
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={guild.enrolled}
            onChange={e => onChange({ enrolled: e.target.checked })}
            aria-label={`Enroll in ${guild.guildName}`}
            className="w-4 h-4 rounded bg-space-800 border-space-700 text-gold accent-gold cursor-pointer"
          />
          <span className="text-xs text-gray-300">Enrolled</span>
        </label>
      </div>

      {guild.enrolled && (
        <div className="px-3 pb-3 pl-[52px] border-t border-gold/10">
          <div className="pt-2 flex flex-col gap-1">
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
          </div>
        </div>
      )}
    </div>
  );
}

function GuildAvatar({ guild, size = 'md' }: { guild: GuildMembershipSummary; size?: 'sm' | 'md' }) {
  const dim = size === 'md' ? 'w-8 h-8 text-xs' : 'w-6 h-6 text-[10px]';
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

// --- Shared bits ------------------------------------------------------------

function LoadingLine() {
  return <div className="text-xs text-gray-500 animate-pulse">Loading…</div>;
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-red-300">{children}</div>;
}

function BackIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 4l-4 4 4 4" />
    </svg>
  );
}
