import { useState, useRef, useEffect, useCallback } from 'react';

interface ClearAllButtonProps {
  onConfirm: () => void;
}

/**
 * Two-click "Clear All" with a 3-second confirm window. First tap arms
 * the button (turns red, asks "Clear?"); second tap confirms. If the
 * user walks away, it disarms on its own so a stale armed state can't
 * fire on the next accidental tap.
 */
export function ClearAllButton({ onConfirm }: ClearAllButtonProps) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    setArmed(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleClick = () => {
    if (armed) {
      onConfirm();
      disarm();
    } else {
      setArmed(true);
      timerRef.current = setTimeout(disarm, 3000);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onBlur={disarm}
      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
        armed
          ? 'bg-red-900/50 text-red-200 border border-red-500/60 hover:bg-red-900/70'
          : 'bg-space-700 text-gray-400 border border-space-600 hover:text-red-300 hover:border-red-500/40'
      }`}
      title={armed ? 'Tap again to confirm' : 'Clear all cards from both sides'}
    >
      {armed ? (
        <>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          Tap to confirm
        </>
      ) : (
        <>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          Clear All
        </>
      )}
    </button>
  );
}
