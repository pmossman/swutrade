export const APP_COMMIT = __APP_COMMIT__;
export const APP_BUILD_TIME = __APP_BUILD_TIME__;

/**
 * True when the app is served from a beta/preview deploy.
 * Covers the custom subdomain (beta.swutrade.com) and Vercel's
 * auto-generated branch preview URLs (swutrade-git-beta-*.vercel.app).
 * Falls through to true on localhost so dev builds also show the badge —
 * reinforces that local work is beta-channel territory.
 */
export function isBetaChannel(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (host.startsWith('beta.')) return true;
  if (host.includes('-git-beta-')) return true;
  return false;
}
