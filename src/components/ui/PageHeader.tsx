import type { ReactNode } from 'react';
import { Logo } from '../Logo';
import { BetaBadge } from '../BetaBadge';

interface PageHeaderProps {
  /** If provided, renders a "Back" button after the wordmark. */
  onBack?: () => void;
  /** Small uppercase-tracked caption below the wordmark (e.g., "Settings",
   *  "My trades"). Pass a string for the standard chrome, or a ReactNode
   *  for richer kickers (ListView's count + sender-handle composition). */
  kicker?: ReactNode;
  /** Right-aligned action slot — AccountMenu, primary CTA, etc. */
  children?: ReactNode;
}

/**
 * Consolidates the Logo + "SWUTrade" wordmark + BetaBadge chrome that
 * was previously duplicated across 7 view files. Extraction keeps the
 * wordmark's layout and tracking locked to one place; any future
 * wordmark tweak lands in a single edit.
 *
 * Visual design is unchanged from the pre-extraction sites; this is
 * pure DRY. If you need a variant (e.g., no wordmark, alternate kicker
 * styling) add a prop rather than branching inline at call sites.
 */
export function PageHeader({ onBack, kicker, children }: PageHeaderProps) {
  return (
    <header>
      <div className="flex items-center gap-3">
        <h1 className="relative flex items-center select-none shrink-0">
          {/* Logo sits flush against the "S" — the tiny ml-px gap matches
              the inter-letter tracking so it reads as a glyph in the
              word, not a separate icon. */}
          <Logo className="w-6 h-6 sm:w-7 sm:h-7 shrink-0" />
          <span className="ml-px text-sm sm:text-lg font-bold tracking-[0.1em] sm:tracking-[0.12em] leading-none">
            <span className="text-gray-200 uppercase">SWU</span><span className="text-gold uppercase">Trade</span>
          </span>
          {/* Beta tag as an absolute-positioned kicker beneath the
              wordmark — text-only, hugs the wordmark baseline so it
              doesn't extend into the content below. */}
          <BetaBadge className="absolute bottom-0 left-7 sm:left-8 translate-y-[calc(100%-2px)]" />
        </h1>
        {(onBack || children) && (
          <div className="ml-auto flex items-center gap-1.5 md:gap-2">
            {children}
            {onBack && <PageHeaderBackButton onBack={onBack} />}
          </div>
        )}
      </div>
      {kicker !== undefined && kicker !== null && (
        typeof kicker === 'string'
          ? (
            <div className="mt-3">
              <span className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">
                {kicker}
              </span>
            </div>
          )
          : <div className="mt-3">{kicker}</div>
      )}
    </header>
  );
}

function PageHeaderBackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="Back"
      className="flex items-center gap-1 px-3 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-400 hover:text-gold"
    >
      <BackIcon className="w-3.5 h-3.5" />
      Back
    </button>
  );
}

function BackIcon({ className }: { className?: string }) {
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
