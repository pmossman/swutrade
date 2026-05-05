import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  /** Render the trigger — receives open state and a toggle callback. */
  trigger: (args: { open: boolean; toggle: () => void }) => React.ReactNode;
  /** Render the panel contents — receives a close callback. */
  children: (args: { close: () => void }) => React.ReactNode;
  /** Alignment of the panel relative to the trigger. `center` is the
   *  default — panel center anchored to trigger center, the most
   *  visually balanced for triggers anywhere in the viewport.
   *  `left` / `right` exist for explicit anchor cases. All variants
   *  clamp to a viewport margin if the chosen anchor would overflow,
   *  and fall back to the opposite edge when one side would clip. */
  align?: 'left' | 'right' | 'center';
  /** When true the popover opens on mount. Useful when a parent
   *  pre-seeds state that the user should see without an extra
   *  click — e.g. shared-link landings with auto-activated chips. */
  defaultOpen?: boolean;
  /** Extra className applied to the panel container. */
  panelClassName?: string;
}

/**
 * Click-outside popover with the panel portaled to document.body and
 * positioned via fixed coordinates from the trigger's getBoundingClientRect.
 * The portal is the load-bearing piece — without it, the panel renders
 * inside whichever ancestor has `overflow-hidden` (e.g. TradeSide's
 * card list on a session page) and gets visibly clipped. Escape closes;
 * click outside (trigger + panel) closes; child can close explicitly.
 */
export function Popover({ trigger, children, align = 'center', defaultOpen = false, panelClassName = '' }: PopoverProps) {
  const [open, setOpen] = useState(defaultOpen);
  // Asymmetric open-on-defaultOpen-flip: a parent flipping the prop
  // true post-mount opens the popover (matches the shared-link
  // recipient flow where chip activation happens in an effect AFTER
  // first render). User-driven close still wins — we don't re-open
  // a popover the user dismissed just because the prop is still
  // true. Same shape as the prior CollapsibleChipFilter.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);

  const toggle = useCallback(() => setOpen(o => !o), []);
  const close = useCallback(() => setOpen(false), []);

  const reposition = useCallback(() => {
    const trig = triggerRef.current;
    if (!trig) return;
    const rect = trig.getBoundingClientRect();
    const top = rect.bottom + 4;
    // Auto-flip alignment when the requested align would push the
    // panel off the opposite edge. The panel's intrinsic width comes
    // from its content, so we approximate using `panelRef` once it's
    // measured (subsequent reposition runs); on the first paint we
    // optimistically apply the requested align and trust the resize
    // observer to correct on the next pass. Without this, a
    // right-aligned panel on a left-side mobile trigger renders with
    // its leading edge off-screen — the chips inside would log as
    // "outside the viewport" to e2e clicks.
    const panelWidth = panelRef.current?.getBoundingClientRect().width
      ?? 320; // matches FilterPopover's fixed width — reasonable default before measure
    const margin = 8;

    if (align === 'center') {
      // Anchor panel center to trigger center. Most visually balanced
      // because the panel feels like it "comes from" the trigger
      // regardless of where the trigger sits in the viewport. Clamp
      // both edges to margin if the centered position would overflow
      // either side (long panel + tight viewport).
      const triggerCenter = rect.left + rect.width / 2;
      const wantedLeft = triggerCenter - panelWidth / 2;
      const wantedRight = wantedLeft + panelWidth;
      if (wantedLeft < margin) {
        setPos({ top, left: margin });
      } else if (wantedRight > window.innerWidth - margin) {
        setPos({ top, right: margin });
      } else {
        setPos({ top, left: wantedLeft });
      }
    } else if (align === 'right') {
      // Anchor right edge to trigger's right edge. If that would put
      // the left edge < margin, fall back to left-align.
      const wouldStartAt = rect.right - panelWidth;
      if (wouldStartAt < margin) {
        setPos({ top, left: margin });
      } else {
        setPos({ top, right: window.innerWidth - rect.right });
      }
    } else {
      // align === 'left'. Anchor left edge to trigger's left edge.
      // If that would put the right edge > viewport - margin, fall
      // back to right-align.
      const wouldEndAt = rect.left + panelWidth;
      if (wouldEndAt > window.innerWidth - margin) {
        setPos({ top, right: margin });
      } else {
        setPos({ top, left: rect.left });
      }
    }
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => reposition();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Ref-callback so we get a second reposition once the panel
  // actually mounts and we can measure its real width. The first
  // reposition runs before mount with a 320px estimate (matches
  // FilterPopover's fixed width); the post-mount pass corrects when
  // the actual panel is narrower (e.g. small mobile viewports clamp
  // the width via calc(100vw-2rem)).
  const panelRefCb = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (node && open) reposition();
  }, [open, reposition]);

  const panel = open && pos && typeof document !== 'undefined' ? createPortal(
    <div
      ref={panelRefCb}
      // pointerEvents: 'auto' is load-bearing when the popover is
      // opened from inside a Radix Dialog. Radix's RemoveScroll +
      // FocusScope set pointer-events: none on body's other
      // descendants while a Dialog is open (so backdrop clicks
      // route to the overlay) — without an explicit override here,
      // the portaled popover panel inherits the pointer-events: none
      // and chips inside it become non-interactive even though they
      // paint correctly above the dialog. Discovered via e2e
      // failures on the Lists drawer when Variant + Set filters
      // moved from inline-expand to FilterPopover.
      style={{ position: 'fixed', top: pos.top, left: pos.left, right: pos.right, pointerEvents: 'auto' }}
      className={`z-[60] bg-space-800 border border-space-600 rounded-lg shadow-xl ${panelClassName}`}
      onClick={e => e.stopPropagation()}
    >
      {children({ close })}
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={triggerRef} className="relative">
      {trigger({ open, toggle })}
      {panel}
    </div>
  );
}
