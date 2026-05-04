import { Popover } from './Popover';

interface FilterPopoverProps {
  /** Pill label (e.g. "VARIANT", "SET"). Rendered in bold-uppercase
   *  to match the existing CollapsibleChipFilter chrome. */
  label: string;
  /** Compact summary shown next to the label when the popover is
   *  closed — typically badge pills for selected items, or "Any" /
   *  "All" when nothing's selected. Same node passed to the prior
   *  CollapsibleChipFilter implementation. */
  summary: React.ReactNode;
  /** Optional trailing action shown inside the popover panel header
   *  (e.g. "Clear"). Only renders when the popover is open. */
  action?: React.ReactNode;
  /** Chip row content. Rendered inside the popover panel. */
  children: React.ReactNode;
}

/**
 * Canonical filter primitive — every filter affordance in the picker
 * row (Variant, Set, Show, More) MUST go through this component.
 * Don't introduce a parallel inline-expand or chip-strip wrapper:
 * one chrome means consistent placement, animation, and click-out
 * behaviour across the whole UI. The earlier `CollapsibleChipFilter`
 * inline-expand was deleted exactly to enforce this.
 *
 * Behavior: tap the pill, panel overlays via `Popover` (portaled to
 * body, fixed-positioned, click-outside + Esc close). Body layout
 * never reflows. Panel anchors to the trigger's right edge so a long
 * row of filter pills doesn't push panels off-screen on the right.
 *
 * Sizing: fixed 320px panel width with a viewport ceiling — chips
 * inside flex-wrap into multiple rows naturally instead of forcing
 * one ultra-wide row that visually drifts away from the trigger.
 */
export function FilterPopover({ label, summary, action, children }: FilterPopoverProps) {
  return (
    <Popover
      align="right"
      // Fixed-width panel so chip strips wrap into a roughly square
      // panel under the trigger instead of stretching to fit the
      // widest chip row. The viewport ceiling keeps it from clipping
      // on narrow phones.
      panelClassName="p-3 w-[min(320px,calc(100vw-2rem))]"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          // Match CollapsibleChipFilter's pill chrome so swapping in
          // and out doesn't visually shift the row.
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
      )}
    >
      {() => (
        <div className="flex flex-col gap-2 text-xs text-gray-200">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] tracking-[0.1em] uppercase font-bold text-gray-500">
              {label}
            </span>
            {action}
          </div>
          {/* Chip row — same layout used inside CollapsibleChipFilter
              so consumer markup is unchanged. */}
          <div className="flex flex-wrap gap-1.5">
            {children}
          </div>
        </div>
      )}
    </Popover>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-2.5 h-2.5 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4.5L6 7.5L9 4.5" />
    </svg>
  );
}
