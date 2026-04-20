import type { AuthApi } from '../hooks/useAuth';
import { AppHeader } from './ui/AppHeader';
import { LoadingState } from './ui/states';
import { useMyTrades, type TradeRow } from '../hooks/useMyTrades';
import { useDrawerContext } from '../contexts/DrawerContext';
import { useNavigation } from '../contexts/NavigationContext';

interface GhostHomeViewProps {
  auth: AuthApi;
}

/**
 * Scoped Home surface for ghost (anonymous) users — `auth.user.isAnonymous`
 * is true. Rendered from App.tsx in place of the signed-in HomeView.
 *
 * A ghost was minted when they scanned a shared-trade QR or created
 * their own open session without signing in. On `/` they only have
 * session rows (no proposals, no community membership, no server-
 * synced lists), so the full four-module dashboard reads as broken —
 * empty My Communities / My Lists / My Stores surfaces look like
 * failures rather than "you haven't signed up yet."
 *
 * Instead we show:
 *   - A "You're signed in as a guest" greeting + prominent
 *     Sign-in-with-Discord CTA. The OAuth-callback merge rewrites
 *     this ghost's sessions to the real user (see api/auth.ts), so
 *     preserving the trades across sign-in is what the CTA actually
 *     promises.
 *   - Their active sessions (filtered to `kind: 'session'` — ghosts
 *     can only have session rows, but the filter makes the intent
 *     explicit and survives any future edge case where a ghost ends
 *     up with a non-session row).
 *   - A secondary "+ New trade" CTA so ghosts can still start a
 *     fresh trade from Home.
 *
 * Deliberately no My Communities / My Lists / My Stores — those all
 * require a real account and their empty states would read as noise.
 * The SessionView's in-session GhostSignInBanner is unchanged; this
 * view is the separate home-level surface.
 */
export function GhostHomeView({ auth }: GhostHomeViewProps) {
  const { user } = auth;
  const nav = useNavigation();
  const { openLists } = useDrawerContext();
  // Same hook the signed-in HomeView uses. A ghost's list will only
  // contain session rows; if anything else sneaks in we filter below
  // so the chrome stays honest about what the viewer can actually see.
  const myTrades = useMyTrades();
  const sessionRows = myTrades.rows.filter(row => row.kind === 'session');

  const handleSignIn = () => {
    // Full-page redirect — the OAuth callback in api/auth.ts detects
    // the ghost cookie on return and rewrites every trade_sessions
    // row to the real user before swapping the session. A client-
    // side navigation would race the cookie swap.
    window.location.href = '/api/auth/discord';
  };

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      {/* Same AppHeader as the signed-in home — logo + NavMenu +
          AccountMenu orient the ghost exactly like a real user. The
          AccountMenu itself knows to render the guest-appropriate
          variant based on `auth.user.isAnonymous`. */}
      <AppHeader auth={auth} onOpenLists={openLists} />

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-4 max-w-5xl mx-auto w-full flex flex-col gap-6">
        <GhostGreetingCard
          username={user?.username ?? null}
          onSignIn={handleSignIn}
          onBuildTrade={nav.toBuildTrade}
        />

        <GhostSessionsList
          status={myTrades.status}
          rows={sessionRows}
        />
      </main>
    </div>
  );
}

// --- Greeting + primary CTA ------------------------------------------------

/**
 * Prominent gold-bordered callout — the same chrome as the Needs-
 * Response surface on the real HomeView so ghosts see "something
 * attention-worthy lives at the top of my page" without mixing up
 * the semantics. Primary action is Sign in; secondary is New trade.
 */
function GhostGreetingCard({
  username,
  onSignIn,
  onBuildTrade,
}: {
  username: string | null;
  onSignIn: () => void;
  onBuildTrade: () => void;
}) {
  return (
    <section
      aria-labelledby="ghost-greeting-heading"
      className="rounded-xl border border-gold/40 bg-gold/8 p-5"
    >
      <h2 id="ghost-greeting-heading" className="text-sm font-bold text-gold mb-1">
        You're signed in as a guest
      </h2>
      <p className="text-[12px] text-gray-300 leading-relaxed mb-4 max-w-prose">
        {username
          ? `Welcome, ${username}. Sign in with Discord to save your trades across devices, find community partners, and keep working where you left off.`
          : 'Sign in with Discord to save your trades across devices, find community partners, and keep working where you left off.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSignIn}
          className="inline-flex items-center justify-center px-4 h-9 rounded-lg bg-gold text-space-900 font-bold text-sm hover:bg-gold-bright transition-colors"
        >
          Sign in with Discord
        </button>
        <button
          type="button"
          onClick={onBuildTrade}
          className="inline-flex items-center justify-center gap-1.5 px-4 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-sm font-medium text-gray-200 hover:text-gold transition-colors"
        >
          <PlusIcon className="w-4 h-4" />
          New trade
        </button>
      </div>
    </section>
  );
}

// --- Active sessions list --------------------------------------------------

/**
 * Minimal inline list of the ghost's active sessions. Intentionally
 * simpler than HomeView's TradeListRow — ghosts can't receive
 * proposals or have settled history, so we skip the expand-peek /
 * state-badge chrome and just show counterpart + counts + "Open".
 * Anchor tags navigate via href so right-click/cmd-click work as
 * expected.
 */
function GhostSessionsList({
  status,
  rows,
}: {
  status: 'loading' | 'ready' | 'error';
  rows: TradeRow[];
}) {
  return (
    <section aria-labelledby="ghost-sessions-heading">
      <h3
        id="ghost-sessions-heading"
        className="flex items-center gap-2 text-[11px] tracking-[0.18em] uppercase text-gray-400 font-bold mb-2"
      >
        Your trades
      </h3>
      {status === 'loading' && <LoadingState label="Loading your trades…" />}
      {status !== 'loading' && rows.length === 0 && (
        <div className="rounded-lg bg-space-800/30 border border-space-700 px-4 py-3 text-xs text-gray-500 leading-relaxed">
          No active trades yet. Start a new trade above, or scan a QR at the shop to join someone else's.
        </div>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {rows.map(row => (
            <li key={`${row.kind}-${row.id}`}>
              <GhostSessionRow row={row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GhostSessionRow({ row }: { row: TradeRow }) {
  const counterpartLabel = row.counterpart
    ? `@${row.counterpart.handle}${row.counterpart.isAnonymous ? ' (guest)' : ''}`
    : row.openSlot
      ? 'Waiting for counterpart'
      : 'Unknown trader';
  return (
    <a
      href={`/s/${encodeURIComponent(row.id)}`}
      className="flex items-center gap-3 px-3 py-2 rounded-lg border border-space-700 bg-space-800/40 hover:border-gold/30 hover:bg-space-800/60 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-100 truncate">{counterpartLabel}</div>
        <div className="text-[11px] text-gray-500 mt-0.5 truncate">
          {row.yourCount} offered · {row.theirCount} received · {timeAgoShort(row.lastActivityAt)}
        </div>
      </div>
      <ChevronIcon className="w-4 h-4 text-gray-500 shrink-0 -rotate-90" />
    </a>
  );
}

// --- small UI helpers (inlined to keep this view self-contained) ----------

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
