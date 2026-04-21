import { useNavigation } from '../contexts/NavigationContext';
import type { AuthApi } from '../hooks/useAuth';

/**
 * UX-A5: one-shot reassurance banner shown the first time a user
 * lands in the app after the OAuth callback merged their ghost
 * sessions into a real account. Silent ownership transitions made
 * users wonder if their in-progress trade survived sign-in; this
 * names the migration explicitly.
 *
 * Renders only when `auth.pendingMergeBanner` is non-null. Dismissal
 * is server-backed (clears the iron-session flag) so it doesn't
 * re-appear on the next /api/auth/me. Optimistic local clear means
 * the banner unmounts immediately on tap regardless of network.
 *
 * Mounts at App root so it's visible regardless of which view the
 * user lands on after sign-in (Home, an existing session, etc.).
 */
export function MergeReassuranceBanner({ auth }: { auth: AuthApi }) {
  const nav = useNavigation();
  const banner = auth.pendingMergeBanner;
  if (!banner) return null;

  const count = banner.carriedCount;
  const noun = count === 1 ? 'trade' : 'trades';

  // Fixed-positioned toast at the top of the viewport. Means every
  // view (Home, SessionView, ProfileView, anything) gets the banner
  // without each owning a render slot for it. z-50 sits above the
  // AppHeader (z-40) so the banner is always on top. Safe-area inset
  // covers iOS notch padding when installed as PWA.
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-0 right-0 z-50 px-3 sm:px-6 pointer-events-none"
      style={{ top: 'max(env(safe-area-inset-top), 0px)' }}
    >
      <div className="max-w-5xl mx-auto pt-3 pointer-events-auto">
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-gold/40 bg-gold/12 backdrop-blur-md text-sm text-gray-100 shadow-lg shadow-black/40">
          <span aria-hidden className="shrink-0 w-7 h-7 rounded-full bg-gold/20 flex items-center justify-center text-gold">
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8l3 3 6-6" />
            </svg>
          </span>
          <div className="flex-1 min-w-0 leading-snug">
            <div className="font-semibold text-gray-100">
              {count === 1
                ? "We carried your trade over."
                : `We carried your ${count} trades over.`}
            </div>
            <div className="text-[12px] text-gray-400 hidden sm:block">
              Anything you started before signing in lives on your account now.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void auth.dismissMergeBanner();
              nav.toTradesHistory();
            }}
            className="shrink-0 px-3 h-9 rounded-lg bg-gold text-space-900 font-bold text-xs hover:bg-gold-bright transition-colors"
          >
            View {noun}
          </button>
          <button
            type="button"
            onClick={() => void auth.dismissMergeBanner()}
            aria-label="Dismiss"
            className="hit-area-44 shrink-0 text-gray-500 hover:text-gray-200 transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
