import { useState } from 'react';
import { PageHeader } from './ui/PageHeader';
import { LoadingState } from './ui/states';
import {
  useAccountSettings,
  type AccountSettingsApi,
  type PrefValue,
} from '../hooks/useAccountSettings';
import {
  useGuildMemberships,
  type GuildMembershipSummary,
} from '../hooks/useGuildMemberships';
import { useAuthContext } from '../contexts/AuthContext';
import { PREF_DEFINITIONS, type PrefDefinition } from '../../lib/prefsRegistry';

interface SettingsViewProps {
  onClose: () => void;
}

/**
 * Full-page /?settings=1 view. Reached from the account menu.
 *
 * Sections:
 *   - Account (visibility + bot DM toggles)
 *   - Your public profile (shareable URL — we removed the "My profile"
 *     menu entry because landing on your own public page in-app was
 *     disorienting; this is the single canonical way to reach it)
 *   - Discord servers (enrolled cards + refresh button + invite block)
 *
 * Saves happen on change via the hooks' optimistic update helpers.
 */
export function SettingsView({ onClose }: SettingsViewProps) {
  const account = useAccountSettings();
  const guilds = useGuildMemberships();
  const auth = useAuthContext();

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <div className="px-3 sm:px-6 pt-3 pb-2 max-w-3xl mx-auto w-full">
        <PageHeader onBack={onClose} kicker="Settings" />
      </div>

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-2 max-w-3xl mx-auto w-full">
        <AccountSection account={account} />
        <PublicProfileSection handle={auth.user?.handle ?? null} />
        <GuildsSection guilds={guilds} botInstallUrl={auth.botInstallUrl} />
      </main>
    </div>
  );
}

// --- Account section --------------------------------------------------------

/**
 * Ordered metadata for each registry section. Order here drives the
 * visual order of fieldsets; sections with no registered prefs drop
 * out of the rendered list automatically. Hand-maintained so we can
 * keep section copy purposeful rather than letting it be derived
 * from scattered pref-level metadata.
 */
const SECTIONS: ReadonlyArray<{
  id: NonNullable<PrefDefinition['section']>;
  label: string;
  description?: string;
}> = [
  {
    id: 'privacy',
    label: 'Privacy',
    description: 'Who can see your profile and which lists are public.',
  },
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

function AccountSection({ account }: { account: AccountSettingsApi }) {
  const { settings, status, update } = account;

  // Only self-scoped, web-surfaced defs render here. Peer-scoped
  // overrides live on the per-user directory view (future slice).
  const selfWebDefs = PREF_DEFINITIONS.filter(
    d => d.scope.kind === 'self' && d.surfaces.includes('web'),
  );
  const bySection = new Map<string, PrefDefinition[]>();
  for (const def of selfWebDefs) {
    const key = def.section ?? 'privacy';
    const list = bySection.get(key) ?? [];
    list.push(def);
    bySection.set(key, list);
  }

  return (
    <section className="mt-6" aria-labelledby="account-heading">
      <h2 id="account-heading" className="text-xs sm:text-sm font-bold tracking-[0.18em] uppercase text-gold/80 pb-2 mb-3 border-b border-gold/20">
        Account
      </h2>

      {status === 'loading' && <LoadingState />}
      {status === 'error' && !settings && (
        <ErrorLine>Couldn't load your settings. Try refreshing.</ErrorLine>
      )}

      {settings && (
        <div className="flex flex-col gap-6">
          {SECTIONS.map(section => {
            const defs = bySection.get(section.id);
            if (!defs?.length) return null;
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
                {defs.map(def => (
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
          <p className="text-[11px] text-gray-500 leading-relaxed pt-2 border-t border-space-700/40">
            Want different behavior with specific traders? Per-trader overrides live in the{' '}
            <a href="/?community=1" className="text-gold hover:underline">Community directory</a>{' '}
            — each member row has its own preference selector. Or use{' '}
            <span className="font-mono text-gray-400">/swutrade settings user:@them</span>{' '}
            in Discord.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * Dispatches a registered pref to the right renderer based on its
 * declared `type`. Boolean prefs get a checkbox row; enum prefs get
 * a <select> where each option concatenates its label and optional
 * description for the reader. A single renderer handles both —
 * bespoke per-pref components are avoided until a pref's needs
 * outgrow what the registry metadata can express.
 */
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

// --- Public profile section -------------------------------------------------

function PublicProfileSection({ handle }: { handle: string | null }) {
  const [copied, setCopied] = useState(false);

  if (!handle) return null;

  const path = `/u/${handle}`;
  const url = typeof window !== 'undefined' ? `${window.location.origin}${path}` : path;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can fail in insecure contexts or when denied —
      // user can still copy from the input manually.
    }
  };

  return (
    <section className="mt-10" aria-labelledby="profile-heading">
      <h2 id="profile-heading" className="text-xs sm:text-sm font-bold tracking-[0.18em] uppercase text-gold/80 pb-2 mb-3 border-b border-gold/20">
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

// --- Guilds section ---------------------------------------------------------

function GuildsSection({
  guilds,
  botInstallUrl,
}: {
  guilds: ReturnType<typeof useGuildMemberships>;
  botInstallUrl: string | null;
}) {
  const { enrollable, status, refreshStatus, refreshFromDiscord, updateGuild } = guilds;
  const refreshBusy = refreshStatus === 'refreshing';

  return (
    <section className="mt-10" aria-labelledby="guilds-heading">
      <div className="flex items-end justify-between gap-3 pb-2 mb-3 border-b border-gold/20">
        <h2 id="guilds-heading" className="text-xs sm:text-sm font-bold tracking-[0.18em] uppercase text-gold/80">
          Discord servers
        </h2>
        <button
          type="button"
          onClick={() => { void refreshFromDiscord(); }}
          disabled={refreshBusy}
          className="flex items-center gap-1.5 px-2.5 h-7 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-[11px] font-medium text-gray-400 hover:text-gold disabled:opacity-50 disabled:cursor-wait"
        >
          <RefreshIcon className={`w-3 h-3 ${refreshBusy ? 'animate-spin' : ''}`} />
          {refreshBusy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <p className="text-xs text-gray-500 leading-relaxed mb-4">
        Enroll in a server to join its trading community — your wants and
        available lists become visible to members, and you get matched
        against their lists. You can enroll in multiple servers. Enrollment
        is optional; you can sign in without joining any community.
      </p>

      {refreshStatus === 'needs-reauth' && (
        <ReauthBanner />
      )}
      {refreshStatus === 'error' && (
        <ErrorLine>Couldn't refresh from Discord. Try again in a moment.</ErrorLine>
      )}

      {status === 'loading' && <LoadingState />}
      {status === 'error' && enrollable.length === 0 && (
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

      <InviteBotBlock botInstallUrl={botInstallUrl} />
    </section>
  );
}

function ReauthBanner() {
  return (
    <div className="rounded-lg bg-amber-500/10 border border-amber-400/30 px-3 py-2.5 mb-4 text-[11px] text-amber-200 leading-relaxed">
      Your Discord session expired. <a href="/api/auth/discord" className="underline font-semibold hover:text-amber-100">Sign in again</a> to
      refresh your server list.
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

function ErrorLine({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-red-300 mb-3">{children}</div>;
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
