import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Two-tap confirmation logic for destructive actions: first tap arms,
 * second tap fires `onConfirm`. Auto-disarms after `timeoutMs`, on the
 * `onBlur` returned (focus moves away), and on unmount so a stale
 * armed state can't fire on a later accidental tap.
 *
 * The hook owns the state machine; the consumer owns the visual
 * (idle vs armed chrome, label, icon). This split exists because the
 * two existing two-tap surfaces — per-row × in `ListRows.tsx` and
 * the bigger "Clear All" button in the trade-builder header — share
 * exactly zero visual treatment but exactly the same state logic.
 *
 * Returns:
 *   - `armed`: whether the button is in the second-tap window
 *   - `onClick`: pass to the button's onClick (handles both arm + fire)
 *   - `onBlur`: pass to the button's onBlur (disarms when focus leaves)
 *
 * Default timeout is 3000 ms — short enough that the user notices,
 * long enough to land the second tap on a phone.
 */
export interface ConfirmActionApi {
  armed: boolean;
  onClick: () => void;
  onBlur: () => void;
}

export function useConfirmAction(
  onConfirm: () => void,
  options: { timeoutMs?: number } = {},
): ConfirmActionApi {
  const { timeoutMs = 3000 } = options;
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    setArmed(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Cleanup on unmount — without this the timer's setArmed would
  // fire on a torn-down component (React 19 surfaces this as a warning).
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onClick = useCallback(() => {
    if (armed) {
      disarm();
      onConfirm();
    } else {
      setArmed(true);
      timerRef.current = setTimeout(() => {
        setArmed(false);
        timerRef.current = null;
      }, timeoutMs);
    }
  }, [armed, disarm, onConfirm, timeoutMs]);

  return { armed, onClick, onBlur: disarm };
}
