import { useCallback, useRef } from 'react';

interface PanelDividerProps {
  /** Ref to the flex-col container holding the two panels — used to
   *  compute the drag ratio relative to container height. */
  containerRef: React.RefObject<HTMLElement | null>;
  onRatioChange: (ratio: number) => void;
}

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

/**
 * Horizontal drag handle that sits between the Offering / Receiving
 * panels on mobile. Dragging up shrinks the top panel, dragging down
 * expands it. Ratio is clamped so neither panel can collapse to zero.
 */
export function PanelDivider({ containerRef, onRatioChange }: PanelDividerProps) {
  const activePointerRef = useRef<number | null>(null);

  const computeRatio = useCallback((clientY: number) => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top;
    const raw = y / rect.height;
    return Math.max(MIN_RATIO, Math.min(MAX_RATIO, raw));
  }, [containerRef]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    activePointerRef.current = e.pointerId;
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerRef.current !== e.pointerId) return;
    const ratio = computeRatio(e.clientY);
    if (ratio !== null) onRatioChange(ratio);
  }, [computeRatio, onRatioChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerRef.current === e.pointerId) {
      activePointerRef.current = null;
    }
  }, []);

  return (
    <div
      className="md:hidden h-3 -my-1 flex items-center justify-center cursor-row-resize touch-none group"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Drag to resize panels"
    >
      <div className="w-12 h-1 rounded-full bg-space-600 group-hover:bg-space-500 transition-colors" />
    </div>
  );
}
