interface StepperProps {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
}

/*
 * Inline qty +/- control. Used on trade-canvas rows and card-picker
 * tiles. Both buttons meet the 44×44 tap-target floor.
 */
export function Stepper({ value, min = 1, max = 99, onChange, ariaLabel }: StepperProps) {
  const canDec = value > min;
  const canInc = value < max;

  return (
    <div
      role="group"
      aria-label={ariaLabel ?? 'Quantity'}
      className="inline-flex h-11 items-center rounded-full border border-border bg-surface"
    >
      <button
        type="button"
        onClick={() => canDec && onChange(value - 1)}
        aria-label="Decrease"
        disabled={!canDec}
        className="grid size-11 place-items-center rounded-l-full text-fg disabled:text-fg-muted/50 hover:bg-border/30"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 8h8" />
        </svg>
      </button>
      <span
        aria-live="polite"
        className="min-w-[28px] px-1 text-center text-[length:var(--text-body)] font-semibold tabular-nums"
      >
        {value}
      </span>
      <button
        type="button"
        onClick={() => canInc && onChange(value + 1)}
        aria-label="Increase"
        disabled={!canInc}
        className="grid size-11 place-items-center rounded-r-full text-fg disabled:text-fg-muted/50 hover:bg-border/30"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M8 4v8M4 8h8" />
        </svg>
      </button>
    </div>
  );
}
