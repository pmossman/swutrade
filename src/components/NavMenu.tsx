import { Popover } from './Popover';

interface NavMenuProps {
  /** True when the viewer has a real Discord-backed account (not a
   *  ghost, not signed-out). Gates community-scoped entries where
   *  ghost participation doesn't make sense. */
  hasAccount: boolean;
  /** True when the viewer has any server-side session — real user OR
   *  ghost with an active trade session. Gates "My Trades" so ghosts
   *  can still reach their in-flight sessions from the hamburger
   *  rather than having to remember the session URL. */
  hasAnySession: boolean;
}

/**
 * Hamburger-style content navigation menu. Separate from AccountMenu —
 * AccountMenu is identity (profile / settings / sign out), NavMenu is
 * "where do I want to go in the app" (Home / Wishlist / Binder /
 * Trades / Community).
 *
 * Two-axis gating reflects the guest-vs-real-user model:
 *   - Always visible: Home / Wishlist / Binder (work offline-first).
 *   - `hasAnySession`: adds "My Trades" so ghost users can reach
 *     their in-flight sessions without remembering the URL.
 *   - `hasAccount`: adds "My Communities" — ghosts can't be enrolled
 *     in bot-installed guilds, so the entry would always render empty.
 *
 * "My Lists" was split into "My Wishlist" + "My Binder" when the
 * Wishlist / Binder split landed. Drawer stays as a trade-builder
 * quick-edit sidebar; it no longer has a global menu entry since the
 * dedicated views are the canonical edit surface.
 */
export function NavMenu({ hasAccount, hasAnySession }: NavMenuProps) {
  return (
    <Popover
      align="right"
      panelClassName="p-2 w-[220px]"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label="Navigation menu"
          aria-expanded={open}
          className="flex items-center justify-center w-8 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-gray-400 hover:text-gold transition-colors"
        >
          <HamburgerIcon className="w-4 h-4" />
        </button>
      )}
    >
      {({ close }) => (
        <div className="flex flex-col gap-0.5">
          <NavRow
            href="/"
            icon={<HomeIcon className="w-3.5 h-3.5 text-gray-400" />}
            label={hasAccount ? 'Home' : 'Trade builder'}
            onClose={close}
          />
          <NavRow
            href="/?view=wishlist"
            icon={<WishlistIcon className="w-3.5 h-3.5 text-gray-400" />}
            label="My Wishlist"
            onClose={close}
          />
          <NavRow
            href="/?view=binder"
            icon={<BinderIcon className="w-3.5 h-3.5 text-gray-400" />}
            label="My Trade Binder"
            onClose={close}
          />
          {hasAnySession && (
            <NavRow
              href="/?trades=1"
              icon={<TradesIcon className="w-3.5 h-3.5 text-gray-400" />}
              label="My Trades"
              onClose={close}
            />
          )}
          {hasAccount && (
            <NavRow
              href="/?community=1"
              icon={<CommunityIcon className="w-3.5 h-3.5 text-gray-400" />}
              label="My Communities"
              onClose={close}
            />
          )}
        </div>
      )}
    </Popover>
  );
}

/**
 * Shared row — renders an <a> for hrefs (so middle-click + cmd-click
 * work as expected) and a <button> for JS-only actions like opening
 * the lists drawer. Single component so spacing + hover states stay
 * consistent across the two.
 */
function NavRow(
  props: (
    | { href: string; onClick?: never; onClose: () => void }
    | { onClick: () => void; href?: never; onClose?: never }
  ) & { icon: React.ReactNode; label: string },
) {
  const cls = 'flex items-center gap-2 px-2 py-1.5 rounded text-xs font-semibold text-gray-200 hover:text-gold hover:bg-gold/10 transition-colors text-left';
  if ('href' in props && props.href) {
    return (
      <a href={props.href} onClick={props.onClose} className={cls}>
        {props.icon}
        {props.label}
      </a>
    );
  }
  return (
    <button type="button" onClick={props.onClick} className={cls}>
      {props.icon}
      {props.label}
    </button>
  );
}

function HamburgerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M2 4h12M2 8h12M2 12h12" />
    </svg>
  );
}

function WishlistIcon({ className }: { className?: string }) {
  // Star outline — parallel to HomeView's WishlistModule icon so the
  // NavMenu and Home module chrome reinforce each other.
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 2l1.85 3.76 4.15.6-3 2.93.7 4.14L8 11.78l-3.7 1.95.7-4.14-3-2.93 4.15-.6L8 2z" />
    </svg>
  );
}

function BinderIcon({ className }: { className?: string }) {
  // Book outline — parallel to HomeView's BinderModule icon.
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 2.5h6.5a2 2 0 0 1 2 2v9L9 11.75H3v-9.25z" />
      <path d="M11.5 4.5H13a0 0 0 0 1 0 0v9l-2.5-1.75" />
    </svg>
  );
}

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 7L8 2.5 13.5 7v6.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V7Z" />
      <path d="M6.5 14.5v-4h3v4" />
    </svg>
  );
}

function TradesIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <path d="M5 7h6M5 9.5h4" />
    </svg>
  );
}

function CommunityIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="5.5" r="2.2" />
      <path d="M1.75 13.25a4.25 4.25 0 0 1 8.5 0" />
      <circle cx="11.25" cy="6.25" r="1.75" />
      <path d="M10 11a3.25 3.25 0 0 1 4.5 1.75" />
    </svg>
  );
}
