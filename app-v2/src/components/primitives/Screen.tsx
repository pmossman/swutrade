import type { ReactNode } from 'react';

interface ScreenProps {
  title?: string;
  children: ReactNode;
  /**
   * When true, the screen reserves space for the bottom tab bar (56px
   * + safe-area-bottom). Off when a screen renders without the tab
   * bar (e.g., the trade canvas in full-focus mode).
   */
  withTabBar?: boolean;
}

export function Screen({ title, children, withTabBar = true }: ScreenProps) {
  return (
    <div
      className="flex min-h-full flex-col bg-bg text-fg"
      style={{
        paddingBottom: withTabBar
          ? 'calc(56px + env(safe-area-inset-bottom))'
          : 'env(safe-area-inset-bottom)',
      }}
    >
      {title ? (
        <header className="px-4 pt-6 pb-2">
          <h1 className="text-[length:var(--text-display)] leading-[length:var(--text-display--line-height)] font-bold">
            {title}
          </h1>
        </header>
      ) : null}
      <main className="flex-1 px-4 pb-4">{children}</main>
    </div>
  );
}
