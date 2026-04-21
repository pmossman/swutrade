import { useCallback, useEffect, useState } from 'react';

/**
 * First-run tutorial state machine for signed-out users.
 *
 * Gated on:
 *   - `isSignedIn` false — signed-in users have committed; the tour's
 *     "sign in with Discord to unlock more" finale is wasted on them.
 *   - `isLoading` false — auth may still be resolving on first paint
 *     and a signed-in user briefly reads as signed-out. Delaying the
 *     activation until auth has settled avoids a flash of tour on
 *     returning users.
 *   - localStorage `swu.tour.dismissedAt` absent — user hasn't seen it.
 *     Skip / Finish both write this key so the tour never auto-resurfaces.
 *
 * `replay()` clears the key and restarts the tour for users who want
 * to see it again from the AccountMenu. Tests can seed the key to
 * suppress activation or call `replay()` to force-show.
 *
 * localStorage failures (private mode, Safari ITP, etc.) fall through
 * silently — no first-run tour is better than a broken one.
 */
export const TUTORIAL_STORAGE_KEY = 'swu.tour.dismissedAt';

export interface TutorialApi {
  isActive: boolean;
  currentStep: number;
  totalSteps: number;
  next: () => void;
  back: () => void;
  dismiss: () => void;
  replay: () => void;
}

export function useTutorial(opts: {
  totalSteps: number;
  isSignedIn: boolean;
  isAuthLoading: boolean;
}): TutorialApi {
  const { totalSteps, isSignedIn, isAuthLoading } = opts;

  const [isActive, setIsActive] = useState<boolean>(false);
  const [currentStep, setCurrentStep] = useState<number>(0);

  useEffect(() => {
    if (isAuthLoading || isSignedIn) return;
    try {
      const dismissed = window.localStorage.getItem(TUTORIAL_STORAGE_KEY);
      if (!dismissed) {
        setIsActive(true);
        setCurrentStep(0);
      }
    } catch {
      // localStorage unavailable — skip silently.
    }
  }, [isAuthLoading, isSignedIn]);

  const next = useCallback(() => {
    setCurrentStep(s => Math.min(s + 1, totalSteps - 1));
  }, [totalSteps]);

  const back = useCallback(() => {
    setCurrentStep(s => Math.max(s - 1, 0));
  }, []);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(TUTORIAL_STORAGE_KEY, new Date().toISOString());
    } catch {
      // Ignore — tour just won't persist in private mode.
    }
    setIsActive(false);
    setCurrentStep(0);
  }, []);

  const replay = useCallback(() => {
    try {
      window.localStorage.removeItem(TUTORIAL_STORAGE_KEY);
    } catch {
      // Ignore.
    }
    setCurrentStep(0);
    setIsActive(true);
  }, []);

  return { isActive, currentStep, totalSteps, next, back, dismiss, replay };
}
