/**
 * Breadcrumb trail for the app header.
 *
 * Mobile collapses to just the current-page label; the parent-back
 * affordance has moved up one level to AppHeader's dedicated Back
 * button, which handles "go up one level" uniformly on every
 * platform. Breadcrumbs here exist for orientation ("where am I in
 * the IA?"), not navigation — the Back button navigates, clickable
 * ancestor segments on desktop are a bonus.
 *
 * Single DOM tree: the non-current segments hide on mobile via
 * Tailwind's `md:` utilities so the current-page label appears
 * exactly once in the document (Playwright strict-mode locators
 * care about this).
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
  const current = segments[segments.length - 1];
  const middleSegments = segments.slice(0, -1); // everything except current

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex items-center gap-1.5 text-[11px] min-w-0">
        {/* Desktop-only full trail (everything except the current page).
            Mobile shows just the current label — AppHeader's Back
            button carries the "go up" semantic on both platforms. */}
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
