/**
 * Breadcrumb trail for the app header. Desktop renders the full path;
 * mobile renders just the parent-back link + current segment. The two
 * variants share a SINGLE DOM tree — the parent-back and the non-tail
 * segments hide/show via Tailwind's `md:` utilities — so the current-
 * page label appears exactly once in the document, avoiding Playwright
 * strict-mode locator collisions.
 *
 * Views declare their breadcrumb path each render:
 *
 *   <AppHeader breadcrumbs={[
 *     { label: 'Home', href: '/' },
 *     { label: 'Settings', href: '/?settings=1' },
 *     { label: 'Discord servers' },
 *   ]} />
 *
 * First item is typically "Home". Last item is the current page and
 * has no `href`.
 */

export interface BreadcrumbSegment {
  label: string;
  /** Omit to mark the current page — rendered unclickable. */
  href?: string;
}

interface BreadcrumbsProps {
  segments: BreadcrumbSegment[];
}

export function Breadcrumbs({ segments }: BreadcrumbsProps) {
  if (segments.length === 0) return null;
  const parent = segments.length > 1 ? segments[segments.length - 2] : null;
  const current = segments[segments.length - 1];
  const middleSegments = segments.slice(0, -1); // everything except current

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex items-center gap-1.5 text-[11px] min-w-0">
        {/* Mobile-only parent back link — compact "‹ <parent>" so the
            right-cluster (actions + NavMenu + AccountMenu) stays
            visible at 375px. Hidden on md+ where the full trail renders. */}
        {parent?.href && (
          <li className="md:hidden flex items-center min-w-0">
            <a
              href={parent.href}
              className="shrink-0 inline-flex items-center gap-0.5 font-semibold text-gray-400 hover:text-gold transition-colors"
            >
              <ChevronLeft className="w-3 h-3" />
              <span className="truncate max-w-[6rem]">{parent.label}</span>
            </a>
            <span className="mx-1.5 text-gray-600 shrink-0" aria-hidden>·</span>
          </li>
        )}

        {/* Desktop-only full trail (everything except the current page). */}
        {middleSegments.map((seg, i) => (
          <li key={i} className="hidden md:flex items-center gap-1.5 min-w-0">
            {i > 0 && <ChevronRight className="w-3 h-3 text-gray-600 shrink-0" aria-hidden />}
            {seg.href ? (
              <a
                href={seg.href}
                className="truncate font-medium text-gray-400 hover:text-gold transition-colors"
              >
                {seg.label}
              </a>
            ) : (
              <span className="truncate font-medium text-gray-400">{seg.label}</span>
            )}
          </li>
        ))}

        {/* Current segment — rendered exactly once in the DOM. The
            chevron before it only shows on desktop where the trail is
            visible. */}
        <li className="flex items-center gap-1.5 min-w-0">
          {middleSegments.length > 0 && (
            <ChevronRight className="hidden md:block w-3 h-3 text-gray-600 shrink-0" aria-hidden />
          )}
          <span className="truncate font-bold text-gray-200" aria-current="page">
            {current.label}
          </span>
        </li>
      </ol>
    </nav>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

function ChevronLeft({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 4l-4 4 4 4" />
    </svg>
  );
}
