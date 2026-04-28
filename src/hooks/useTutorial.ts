import { useCallback, useState } from 'react';

/**
 * First-run tutorial state machine. Opt-in only as of 2026-04-28 —
 * auto-firing on first visit was too aggressive (auto-firing on top
 * of a real interaction the user came here to do reads as an
 * interrupt). Now surfaces as a glowing help icon in AppHeader that
 * users tap when they want the tour, and tucks itself away once
 * they've seen it.
 *
 * Surface-level gating:
 *   - `hasBeenSeen` derived from localStorage `swu.tour.dismissedAt`
 *     so the AppHeader can decide whether to show the icon's glow
 *     pulse (first-time visitors) vs hide the icon entirely
 *     (post-dismissal). The `replay()` action stays available via
 *     AccountMenu's "Show tutorial" entry as the tucked-away access.
 *   - `replay()` clears `dismissedAt` and starts the tour, so a user
 *     who wants to see it again gets the same fresh-eyes experience.
 *   - `dismiss()` writes `dismissedAt` and stops the tour. Skip and
 *     Finish both call dismiss.
 *
 * localStorage failures (private mode, Safari ITP, etc.) fall through
 * silently — `hasBeenSeen` defaults to false in that case so the
 * glowing icon stays visible (better than silently hiding the
 * affordance).
 */
export const TUTORIAL_STORAGE_KEY = 'swu.tour.dismissedAt';

export interface TutorialApi {
  isActive: boolean;
  currentStep: number;
  totalSteps: number;
  /** True when the user has previously dismissed (skipped or finished)
   *  the tour. Drives the AppHeader help-icon glow + visibility. */
  hasBeenSeen: boolean;
  next: () => void;
  back: () => void;
  dismiss: () => void;
  replay: () => void;
}

export function useTutorial(opts: {
  totalSteps: number;
}): TutorialApi {
  const { totalSteps } = opts;

  const [isActive, setIsActive] = useState<boolean>(false);
  const [currentStep, setCurrentStep] = useState<number>(0);
  // Initialised lazily from localStorage on first render so the help
  // icon's glow state is correct on the very first paint (not "glow,
  // then hide a frame later"). Updated by dismiss / replay.
  const [hasBeenSeen, setHasBeenSeen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(TUTORIAL_STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  });

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
    setHasBeenSeen(true);
  }, []);

  const replay = useCallback(() => {
    try {
      window.localStorage.removeItem(TUTORIAL_STORAGE_KEY);
    } catch {
      // Ignore.
    }
    setCurrentStep(0);
    setIsActive(true);
    // Replay clears the seen flag so an explicit "show me again"
    // resets the affordance state symmetrically — the icon would
    // re-glow until the next dismiss. In practice that's fine
    // because the tour itself is now in front of the user.
    setHasBeenSeen(false);
  }, []);

  return { isActive, currentStep, totalSteps, hasBeenSeen, next, back, dismiss, replay };
}
