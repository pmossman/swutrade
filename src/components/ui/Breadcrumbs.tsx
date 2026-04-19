/**
 * Breadcrumb trail for the app header. Desktop renders the full path
 * as clickable links (current segment unclickable). Mobile collapses
 * to a single "‹ <parent label>" back link + the current segment
 * label truncated, since the full trail chews through a 375px
 * viewport alongside the logo + NavMenu + AccountMenu.
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

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      {/* Mobile: parent-only back link + truncated current label. */}
      <div className="flex items-center gap-1.5 min-w-0 md:hidden">
        {parent?.href && (
          <a
            href={parent.href}
            className="shrink-0 inline-flex items-center gap-0.5 text-[11px] font-semibold text-gray-400 hover:text-gold transition-colors"
          >
            <ChevronLeft className="w-3 h-3" />
            <span className="truncate max-w-[6rem]">{parent.label}</span>
          </a>
        )}
        {parent && (
          <span className="shrink-0 text-gray-600" aria-hidden>·</span>
        )}
        <span className="min-w-0 truncate text-[11px] font-bold text-gray-200" aria-current="page">
          {current.label}
        </span>
      </div>

      {/* Desktop: full trail. */}
      <ol className="hidden md:flex items-center gap-1.5 text-[11px] min-w-0">
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1;
          return (
            <li key={i} className="flex items-center gap-1.5 min-w-0">
              {i > 0 && <ChevronRight className="w-3 h-3 text-gray-600 shrink-0" aria-hidden />}
              {isLast || !seg.href ? (
                <span
                  className="truncate font-bold text-gray-200"
                  aria-current={isLast ? 'page' : undefined}
                >
                  {seg.label}
                </span>
              ) : (
                <a
                  href={seg.href}
                  className="truncate font-medium text-gray-400 hover:text-gold transition-colors"
                >
                  {seg.label}
                </a>
              )}
            </li>
          );
        })}
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
