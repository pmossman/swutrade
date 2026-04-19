import type { ReactNode } from 'react';
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
  /** Right-aligned action slot shown BEFORE the NavMenu / AccountMenu
   *  cluster — used by views that have a primary in-header CTA (e.g.
   *  "Done" on Settings, the split/tabbed toggle on the trade builder). */
  actions?: ReactNode;
  /** When true, hide NavMenu + AccountMenu content-chrome and render
   *  a slim version — used on shared-link views where the viewer may
   *  be anonymous and we don't want to push them toward sign-up
   *  chrome before they've seen the list they came to see. */
  slim?: boolean;
}

/**
 * Always-on top chrome for every view. Provides the consistent
 * orientation the product was missing — the logo, breadcrumb trail,
 * content nav, and account menu all live here on every page.
 *
 * Layout:
 *   [Logo]  [breadcrumbs ·····]  [actions]  [NavMenu]  [AccountMenu]
 *
 * Mobile (≤md): breadcrumbs collapse to "‹ parent · current" to keep
 * the right-cluster visible at 375px.
 *
 * Views render this at the top of their return. The old PageHeader
 * component is now a content-level primitive (kicker + action slot
 * inside the main area); if you're touching a view that uses
 * PageHeader for the Logo/Back/AccountMenu slot, migrate to AppHeader
 * at the view's root and keep PageHeader for its content-header
 * duties (or drop it entirely — the breadcrumb often covers what
 * PageHeader's kicker used to).
 */
export function AppHeader({
  auth,
  breadcrumbs,
  onOpenLists,
  actions,
  slim = false,
}: AppHeaderProps) {
  const signedIn = !!auth.user;
  const showNavMenu = !slim && onOpenLists !== undefined;
  const showAccountMenu = !slim;

  return (
    <header className="flex items-center gap-3 px-3 sm:px-6 py-3 border-b border-space-800/70 bg-space-900/80 backdrop-blur">
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

      {breadcrumbs && breadcrumbs.length > 0 && (
        <>
          <span className="hidden md:inline-block w-px h-4 bg-space-700" aria-hidden />
          <Breadcrumbs segments={breadcrumbs} />
        </>
      )}

      <div className="ml-auto flex items-center gap-1.5 md:gap-2 shrink-0">
        {actions}
        {showNavMenu && onOpenLists && (
          <NavMenu signedIn={signedIn} onOpenLists={onOpenLists} />
        )}
        {showAccountMenu && <AccountMenu auth={auth} />}
      </div>
    </header>
  );
}
