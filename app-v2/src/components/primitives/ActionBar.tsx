import type { ReactNode } from 'react';

interface ActionBarProps {
  primary: ReactNode;
  secondary?: ReactNode;
  tertiary?: ReactNode;
}

/*
 * Bottom-pinned action strip. Sits above the tab bar (or the
 * safe-area when a screen renders without the tab bar). One primary
 * button + up to two secondaries. Primary button is always
 * visually dominant (accent-colored, full-width when alone).
 */
export function ActionBar({ primary, secondary, tertiary }: ActionBarProps) {
  return (
    <div
      className="fixed inset-x-0 z-20 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur"
      style={{
        bottom: 'calc(56px + env(safe-area-inset-bottom))',
      }}
    >
      <div className="mx-auto flex max-w-xl items-center gap-2">
        {tertiary ? <div className="shrink-0">{tertiary}</div> : null}
        {secondary ? <div className="shrink-0">{secondary}</div> : null}
        <div className="min-w-0 flex-1">{primary}</div>
      </div>
    </div>
  );
}
