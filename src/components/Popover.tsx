import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  /** Render the trigger — receives open state and a toggle callback. */
  trigger: (args: { open: boolean; toggle: () => void }) => React.ReactNode;
  /** Render the panel contents — receives a close callback. */
  children: (args: { close: () => void }) => React.ReactNode;
  /** Alignment of the panel relative to the trigger. */
  align?: 'left' | 'right';
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
export function Popover({ trigger, children, align = 'right', panelClassName = '' }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);

  const toggle = useCallback(() => setOpen(o => !o), []);
  const close = useCallback(() => setOpen(false), []);

  const reposition = useCallback(() => {
    const trig = triggerRef.current;
    if (!trig) return;
    const rect = trig.getBoundingClientRect();
    if (align === 'right') {
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    } else {
      setPos({ top: rect.bottom + 4, left: rect.left });
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

  const panel = open && pos && typeof document !== 'undefined' ? createPortal(
    <div
      ref={panelRef}
      style={{ position: 'fixed', top: pos.top, left: pos.left, right: pos.right }}
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
