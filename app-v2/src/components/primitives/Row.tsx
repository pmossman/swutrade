import type { ReactNode } from 'react';

interface RowProps {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  /**
   * When true, the row renders as a button with full-row hover +
   * active states. Otherwise it's a plain <div> — useful for display
   * rows that only have trailing actions.
   */
  interactive?: boolean;
}

export function Row({ leading, title, subtitle, trailing, onClick, interactive }: RowProps) {
  const content = (
    <>
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-body)] font-semibold">
          {title}
        </span>
        {subtitle ? (
          <span className="block truncate text-[length:var(--text-meta)] leading-[length:var(--text-meta--line-height)] text-fg-muted">
            {subtitle}
          </span>
        ) : null}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </>
  );

  if (interactive || onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-border/30 active:bg-border/50"
      >
        {content}
      </button>
    );
  }

  return <div className="flex min-h-11 items-center gap-3 px-4 py-3">{content}</div>;
}
