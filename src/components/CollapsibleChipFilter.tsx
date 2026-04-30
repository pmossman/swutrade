import { useState } from 'react';

interface CollapsibleChipFilterProps {
  label: string;
  /** Compact selection summary shown next to the label when closed.
   *  Hidden when the chip strip is expanded — the chips themselves
   *  already say what's selected. Accepts a node so callers can
   *  render colored badge pills (variant filter) instead of plain
   *  text. */
  summary: React.ReactNode;
  /** When true the chips expand inline; tapping the header toggles. */
  defaultOpen?: boolean;
  /** Small trailing action (e.g. "Clear") — only shown when open. */
  action?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Pill-style header that expands to reveal a chip strip. Used for the
 * variant and set filters in both the trade search and the lists
 * picker. Summary shows when collapsed; once expanded it's hidden so
 * the same selection isn't echoed twice (header text + chip row).
 */
export function CollapsibleChipFilter({
  label,
  summary,
  defaultOpen = false,
  action,
  children,
}: CollapsibleChipFilterProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-space-800/60 border border-space-700 hover:border-gray-500 text-[11px] transition-colors"
        >
          <span className="font-bold tracking-[0.1em] uppercase text-gray-400">
            {label}
          </span>
          {!open && (
            <span className="flex items-center gap-1 text-gray-200 normal-case tracking-normal font-medium">
              {summary}
            </span>
          )}
          <Chevron open={open} />
        </button>
        {open && action}
      </div>
      {open && (
        <div className="rounded-md border border-space-700 bg-space-800/40 p-2">
          <div className="flex items-center gap-1 flex-wrap">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-3 h-3 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

interface ChipProps {
  active: boolean;
  onClick: () => void;
  colorClass?: string;
  children: React.ReactNode;
}

export function Chip({ active, onClick, colorClass, children }: ChipProps) {
  const base = 'text-[10px] leading-none px-2 py-1 rounded font-bold uppercase tracking-wide transition-opacity border';
  const activeClasses = colorClass ?? 'bg-space-700 text-gray-200 border-space-600';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} ${activeClasses} ${active ? '' : 'opacity-30 border-transparent'}`}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
