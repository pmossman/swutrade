import type { ReactNode } from 'react';

export type ChipTone =
  | 'neutral'
  | 'accent'
  | 'shared'
  | 'attention'
  | 'settled'
  | 'declined'
  | 'countered';

interface ChipProps {
  tone?: ChipTone;
  children: ReactNode;
  /** Aria label on the chip element when the visible text isn't sufficient. */
  ariaLabel?: string;
}

const TONE_CLASSES: Record<ChipTone, string> = {
  neutral: 'bg-border/40 text-fg-muted border-border',
  accent: 'bg-accent/15 text-accent border-accent/40',
  shared: 'bg-state-shared/15 text-state-shared border-state-shared/40',
  attention: 'bg-state-attention/15 text-state-attention border-state-attention/40',
  settled: 'bg-state-settled/15 text-state-settled border-state-settled/40',
  declined: 'bg-state-declined/15 text-state-declined border-state-declined/40',
  countered: 'bg-state-countered/15 text-state-countered border-state-countered/40',
};

export function Chip({ tone = 'neutral', children, ariaLabel }: ChipProps) {
  return (
    <span
      aria-label={ariaLabel}
      className={[
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[length:var(--text-caption)] leading-[length:var(--text-caption--line-height)] font-semibold',
        TONE_CLASSES[tone],
      ].join(' ')}
    >
      {children}
    </span>
  );
}
