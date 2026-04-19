import type { AuthApi } from '../hooks/useAuth';
import { Popover } from './Popover';

interface AccountMenuProps {
  auth: AuthApi;
}

/**
 * Header-level identity affordance — strictly account-scoped:
 *   Signed in: profile · settings · sign out
 *   Signed out: short explainer + Discord sign-in CTA
 *
 * Content navigation (My Lists / My Trades / My Communities) lives in
 * the separate NavMenu. This split was beta feedback — users read "My
 * Lists" under the account menu as account data rather than content,
 * and the duplicate affordances made the header feel muddled.
 */
export function AccountMenu({ auth }: AccountMenuProps) {
  const { user, isLoading, logout } = auth;

  if (isLoading) return null;

  if (!user) {
    // Signed-out: anonymous-silhouette avatar that opens a short
    // popover introducing what signing in unlocks. Keeps the trigger
    // visually parallel to the signed-in avatar so the "this is your
    // account" mental model holds even when there's no account yet.
    return (
      <Popover
        align="right"
        panelClassName="p-2 w-[240px]"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-label="Account menu"
            aria-expanded={open}
            className="flex items-center gap-1.5 pl-1 pr-2 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-400 hover:text-gold"
          >
            <span
              className="w-6 h-6 rounded-full bg-space-700 flex items-center justify-center"
              aria-hidden
            >
              <AnonAvatarIcon className="w-4 h-4 text-gray-400" />
            </span>
            <ChevronDown className={`hidden sm:block w-3 h-3 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      >
        {() => (
          <div className="flex flex-col gap-1">
            <div className="px-2 py-1.5 border-b border-space-700 mb-1">
              <div className="text-sm font-semibold text-gray-100">Not signed in</div>
              <div className="text-[11px] text-gray-500 leading-relaxed">
                Sync lists, share a profile, and match trades with other players.
              </div>
            </div>

            <a
              href="/api/auth/discord"
              className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-semibold bg-[#5865F2]/20 border border-[#5865F2]/40 text-white hover:bg-[#5865F2]/30 hover:border-[#5865F2]/60 transition-colors"
            >
              <DiscordIcon className="w-3.5 h-3.5" />
              Sign in with Discord
            </a>
          </div>
        )}
      </Popover>
    );
  }

  return (
    <Popover
      align="right"
      panelClassName="p-2 w-[200px]"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label="Account menu"
          aria-expanded={open}
          className="flex items-center gap-1.5 pl-1 pr-2 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-400 hover:text-gold"
        >
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              className="w-6 h-6 rounded-full"
            />
          ) : (
            <span
              className="w-6 h-6 rounded-full bg-space-700 text-gold flex items-center justify-center text-[10px] font-bold uppercase"
              aria-hidden
            >
              {user.username.slice(0, 1)}
            </span>
          )}
          <span className="hidden sm:inline max-w-[140px] truncate">{user.username}</span>
          <ChevronDown className={`hidden sm:block w-3 h-3 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}
    >
      {({ close }) => (
        <div className="flex flex-col gap-1">
          <div className="px-2 py-1.5 border-b border-space-700 mb-1">
            <div className="text-sm font-semibold text-gray-100 truncate">{user.username}</div>
            <div className="text-[11px] text-gray-500 truncate">@{user.handle}</div>
          </div>

          <a
            href={`/u/${encodeURIComponent(user.handle)}`}
            onClick={close}
            className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-semibold text-gray-200 hover:text-gold hover:bg-gold/10 transition-colors"
          >
            <ProfileIcon className="w-3.5 h-3.5 text-gray-400" />
            Public profile
          </a>

          <a
            href="/?settings=1"
            onClick={close}
            className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-semibold text-gray-200 hover:text-gold hover:bg-gold/10 transition-colors"
          >
            <SettingsIcon className="w-3.5 h-3.5 text-gray-400" />
            Settings
          </a>

          <button
            type="button"
            onClick={() => { void logout(); close(); }}
            className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-semibold text-gray-200 hover:text-red-300 hover:bg-red-500/10 transition-colors text-left"
          >
            <SignOutIcon className="w-3.5 h-3.5 text-gray-400" />
            Sign out
          </button>
        </div>
      )}
    </Popover>
  );
}

function AnonAvatarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="currentColor" aria-hidden>
      <path d="M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M4 16.5a6 6 0 0 1 12 0c0 .28-.22.5-.5.5H4.5a.5.5 0 0 1-.5-.5Z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M13.545 2.907a13.2 13.2 0 0 0-3.257-1.011.05.05 0 0 0-.052.025c-.141.25-.297.577-.406.833a12.2 12.2 0 0 0-3.658 0 8 8 0 0 0-.412-.833.05.05 0 0 0-.052-.025c-1.125.194-2.22.534-3.257 1.011a.04.04 0 0 0-.021.018C.356 6.024-.213 9.047.066 12.032q.003.022.021.037a13.3 13.3 0 0 0 3.995 2.02.05.05 0 0 0 .056-.019q.463-.63.818-1.329a.05.05 0 0 0-.01-.057.05.05 0 0 0-.018-.011 8.8 8.8 0 0 1-1.248-.595.05.05 0 0 1-.005-.084q.124-.093.248-.19a.05.05 0 0 1 .051-.007c2.619 1.196 5.454 1.196 8.041 0a.05.05 0 0 1 .053.007q.121.1.248.19a.05.05 0 0 1-.004.084 8.3 8.3 0 0 1-1.249.594.05.05 0 0 0-.03.058.05.05 0 0 0 .003.01q.36.698.818 1.329a.05.05 0 0 0 .056.019 13.2 13.2 0 0 0 4.001-2.02.05.05 0 0 0 .021-.037c.334-3.451-.559-6.449-2.366-9.106a.03.03 0 0 0-.02-.019" />
    </svg>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function ProfileIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M2.5 13.5a5.5 5.5 0 0 1 11 0" />
    </svg>
  );
}

function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 11.5L13 8l-3-3.5M13 8H6M7 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H7" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="currentColor" aria-hidden>
      <path fillRule="evenodd" clipRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.99 6.99 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.05 7.05 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.99 6.99 0 0 1-1.929 1.115L12.16 19a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.99 6.99 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.82 8.577a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.99 6.99 0 0 1 7.51 4.26l.33-1.456ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
    </svg>
  );
}
