import type { ReactNode } from 'react';

interface FABProps {
  onClick?: () => void;
  ariaLabel: string;
  children?: ReactNode;
  /**
   * Offset from the bottom edge in px, added to safe-area-inset. Use
   * for screens with a tab bar (adds 56px + safe-area + 16px gap) vs
   * without (just 16px). Defaults to tab-bar-aware.
   */
  withTabBar?: boolean;
}

export function FAB({ onClick, ariaLabel, children, withTabBar = true }: FABProps) {
  const bottomOffset = withTabBar
    ? 'calc(56px + env(safe-area-inset-bottom) + 16px)'
    : 'calc(env(safe-area-inset-bottom) + 16px)';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="fixed right-4 z-30 grid size-14 place-items-center rounded-full bg-accent text-accent-fg shadow-lg transition-transform active:scale-95"
      style={{ bottom: bottomOffset }}
    >
      {children ?? <IconPlus />}
    </button>
  );
}

function IconPlus() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M11 4v14M4 11h14" />
    </svg>
  );
}
