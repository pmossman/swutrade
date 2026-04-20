interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}

/*
 * iOS-style two-or-three-item toggle. Row of buttons inside a pill
 * container; the active button gets the accent fill. 44px tall per
 * §7.10's tap-target floor.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex h-11 items-center gap-1 rounded-full border border-border bg-border/30 p-1"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={[
              'h-9 min-w-[44px] rounded-full px-4 text-[length:var(--text-meta)] font-semibold transition-colors',
              active ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
