/**
 * Feature-detected haptic feedback for mobile moments.
 *
 * Thin wrapper over `navigator.vibrate`. Supported on Android Chrome +
 * some Android browsers; silently no-ops on desktop, iOS Safari
 * (which doesn't expose the Vibration API), and SSR. That means
 * callers NEVER need to guard — just call the intent-shaped helpers
 * and the API handles the "not available" case.
 *
 * Respects `prefers-reduced-motion` as an accessibility measure:
 * users who've opted out of motion on their OS also get no haptics.
 * This mirrors v2's design-doc rule: "haptics suppress when the
 * reduce-motion flag is set." The check happens at call time, not
 * module load, so a user who toggles the OS preference mid-session
 * gets the updated behavior without a reload.
 *
 * Intent-shaped API (soft / medium / success / error) instead of raw
 * millisecond numbers so call sites read what the haptic *means*
 * rather than what it technically does. The mapping is centralised
 * here so tuning the feel is one-file.
 */

function isVibrationAvailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.vibrate !== 'function') return false;
  return true;
}

function reducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Safe, feature-detected, reduced-motion-aware fire-and-forget. */
function vibrate(pattern: number | number[]): void {
  if (!isVibrationAvailable() || reducedMotion()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some browsers can throw on unusual patterns; callers never care.
  }
}

/** Toggle / select feedback — quickest, used for lightweight state
 *  changes (tab switch, segmented control). */
export function hapticSoft(): void {
  vibrate(10);
}

/** Confirm / submit tap — slightly weightier so the user *feels* the
 *  difference between a mere selection and a commit. Used for the
 *  trade Confirm, proposal Send, Accept / Decline, Cancel trade. */
export function hapticMedium(): void {
  vibrate(20);
}

/** Success moment — trade settled, proposal accepted. Double-pulse
 *  reads as "something just completed" rather than "something fired". */
export function hapticSuccess(): void {
  vibrate([14, 50, 14]);
}

/** Error / rejection — longer single pulse so it's distinguishable
 *  from a plain medium tap without being jarring. Used for rate-limit
 *  blocks, send failures, invalid-handle validation. */
export function hapticError(): void {
  vibrate(60);
}
