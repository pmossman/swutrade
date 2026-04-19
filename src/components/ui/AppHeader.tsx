import { Logo } from '../Logo';
import { BetaBadge } from '../BetaBadge';
import { AccountMenu } from '../AccountMenu';
import { NavMenu } from '../NavMenu';
import { Breadcrumbs, type BreadcrumbSegment } from './Breadcrumbs';
import type { AuthApi } from '../../hooks/useAuth';

export type { BreadcrumbSegment };

interface AppHeaderProps {
  auth: AuthApi;
  /** Path from root to current page. The last segment is treated as the
   *  current page (no href, not clickable). Omit entirely on views
   *  that are "root" (Home, trade builder) — the logo alone orients. */
  breadcrumbs?: BreadcrumbSegment[];
  /** Open the ListsDrawer. The drawer lives at each view's root, so
   *  the header doesn't own it — it just triggers. When omitted, the
   *  NavMenu's "My Lists" entry is hidden. */
  onOpenLists?: () => void;
  /** When true, hide NavMenu + AccountMenu content-chrome and render
   *  a slim version — used on shared-link views where the viewer may
   *  be anonymous and we don't want to push them toward sign-up
   *  chrome before they've seen the list they came to see. */
  slim?: boolean;
}

/**
 * Always-on top chrome. Four roles only: identity (logo), orientation
 * (breadcrumbs), escape (Back button), global nav (NavMenu +
 * AccountMenu). Deliberately has NO contextual-action slot — view-
 * specific CTAs like "Trade with @X", "Done", or "Share" belong in the
 * view's own content area so a long breadcrumb trail can't starve the
 * CTA of width, and the CTA can be designed per-view (hero on profile,
 * tight strip on settings, etc.).
 *
 * Layout:
 *   [Logo]  [← Back]  [breadcrumbs ·····]  [NavMenu]  [AccountMenu]
 *
 * The Back button renders automatically when `breadcrumbs` has ≥2
 * segments AND the second-to-last carries an `href` — it reads that
 * href as the destination. Views declare their trail once; the Back
 * button falls out of it for free. Mobile + desktop get the same
 * affordance; the breadcrumb itself collapses to just the current
 * page on mobile since Back carries the "go up" semantic.
 */
export function AppHeader({
  auth,
  breadcrumbs,
  onOpenLists,
  slim = false,
}: AppHeaderProps) {
  const signedIn = !!auth.user;
  const showNavMenu = !slim;
  const showAccountMenu = !slim;
  // Derive the back target from the breadcrumb trail. The parent is
  // the second-to-last segment; if it has no href (unusual — typically
  // only the CURRENT page lacks an href), we don't surface the button.
  const parent = breadcrumbs && breadcrumbs.length >= 2
    ? breadcrumbs[breadcrumbs.length - 2]
    : null;
  const backHref = parent?.href ?? null;

  return (
    <header className="relative z-40 flex items-center gap-3 px-3 sm:px-6 py-3 border-b border-space-800/70 bg-space-900/80 backdrop-blur">
      <h1 className="shrink-0">
        <a
          href="/"
          aria-label="SWUTrade home"
          className="relative flex items-center select-none rounded-md hover:opacity-90 transition-opacity"
        >
          <Logo className="w-6 h-6 sm:w-7 sm:h-7 shrink-0" />
          <span className="ml-px text-sm sm:text-lg font-bold tracking-[0.1em] sm:tracking-[0.12em] leading-none">
            <span className="text-gray-200 uppercase">SWU</span><span className="text-gold uppercase">Trade</span>
          </span>
          <BetaBadge className="absolute bottom-0 left-7 sm:left-8 translate-y-[calc(100%-2px)]" />
        </a>
      </h1>

      {backHref && (
        <BackButton href={backHref} label={parent?.label ?? 'Back'} />
      )}

      {breadcrumbs && breadcrumbs.length > 0 && (
        <>
          <span className="hidden md:inline-block w-px h-4 bg-space-700" aria-hidden />
          <Breadcrumbs segments={breadcrumbs} />
        </>
      )}

      <div className="ml-auto flex items-center gap-1.5 md:gap-2 shrink-0">
        {showNavMenu && (
          <NavMenu signedIn={signedIn} onOpenLists={onOpenLists} />
        )}
        {showAccountMenu && <AccountMenu auth={auth} />}
      </div>
    </header>
  );
}

/**
 * Compact back-one-level link. Rendered as an `<a>` (not a button) so
 * middle-click / cmd-click / right-click-to-copy-link all behave as
 * users expect. The underlying navigation still round-trips through
 * the URL, which triggers AppHeader's state re-sync via useTradeIntent's
 * popstate listener (parent-segment hrefs are already bare-URL shaped —
 * no intent params to mirror).
 *
 * `label` is used for screen readers (`Back to <label>`) and as a
 * desktop-only visible hint ("← Back"). Mobile shows only the icon to
 * preserve header width.
 */
function BackButton({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      aria-label={`Back to ${label}`}
      className="shrink-0 inline-flex items-center gap-1 px-2 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-[11px] font-medium text-gray-400 hover:text-gold"
    >
      <BackArrow className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">Back</span>
    </a>
  );
}

function BackArrow({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 4L6 8l4 4" />
    </svg>
  );
}
