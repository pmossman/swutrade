import { useEffect, useRef, useState, useCallback } from 'react';

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
 * Minimal click-outside popover. Not trying to compete with Radix —
 * just enough for our kebab menus and the collapsed price-slider.
 * Escape closes; click outside closes; child can close explicitly.
 */
export function Popover({ trigger, children, align = 'right', panelClassName = '' }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => setOpen(o => !o), []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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

  return (
    <div ref={rootRef} className="relative">
      {trigger({ open, toggle })}
      {open && (
        <div
          className={`absolute top-full mt-1 z-30 bg-space-800 border border-space-600 rounded-lg shadow-xl ${align === 'right' ? 'right-0' : 'left-0'} ${panelClassName}`}
          onClick={e => e.stopPropagation()}
        >
          {children({ close })}
        </div>
      )}
    </div>
  );
}
