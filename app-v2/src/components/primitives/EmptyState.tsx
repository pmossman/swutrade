import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <h2 className="text-[length:var(--text-title)] leading-[length:var(--text-title--line-height)] font-semibold">
        {title}
      </h2>
      {body ? (
        <p className="max-w-sm text-[length:var(--text-body)] leading-[length:var(--text-body--line-height)] text-fg-muted">
          {body}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
