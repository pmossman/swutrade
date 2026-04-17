import type { ReactNode } from 'react';

/**
 * Small pulsing text line used while a view's primary resource is in
 * flight. Matches the `text-xs text-gray-500 animate-pulse` pattern
 * that recurred across every list-fetching view. Use the centered
 * variant when the view has no other content to anchor yet.
 */
export function LoadingState({
  label = 'Loading…',
  centered = false,
  className = '',
}: {
  label?: string;
  /** Center the pulse in a full-bleed container (for page-level loads
   *  where the whole viewport is waiting). */
  centered?: boolean;
  className?: string;
}) {
  if (centered) {
    return (
      <div className={`flex-1 flex items-center justify-center py-16 ${className}`}>
        <span className="text-gray-500 animate-pulse">{label}</span>
      </div>
    );
  }
  return <div className={`text-xs text-gray-500 animate-pulse ${className}`}>{label}</div>;
}

/**
 * Card-style empty state. Used when a list endpoint returned zero
 * rows and we want to explain why + what to do next. `title` is the
 * bold one-liner ("No one to trade with yet."), `children` is the
 * smaller explanation paragraph below it.
 */
export function EmptyState({
  title,
  children,
  className = '',
}: {
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg bg-space-800/40 border border-space-700 px-4 py-6 text-sm text-gray-400 leading-relaxed ${className}`}>
      <p className="font-semibold text-gray-200 mb-2">{title}</p>
      {children && <p className="text-xs text-gray-500">{children}</p>}
    </div>
  );
}

/**
 * Card-style error state. Distinct red tint so it stands out from the
 * surrounding chrome without being an alert banner. Use for failed
 * fetches where the user can retry by refreshing.
 */
export function ErrorState({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-3 text-sm text-red-300 ${className}`}>
      {children}
    </div>
  );
}
