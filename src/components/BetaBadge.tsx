import { APP_COMMIT, APP_BUILD_TIME, isBetaChannel } from '../version';

/**
 * Small pill shown next to the wordmark on beta/preview builds. Hover
 * reveals commit + build time so we can confirm at a glance whether a
 * given tab has picked up the latest push.
 */
export function BetaBadge() {
  if (!isBetaChannel()) return null;
  const title = `Beta build ${APP_COMMIT} · ${new Date(APP_BUILD_TIME).toLocaleString()}`;
  return (
    <span
      title={title}
      className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] rounded bg-gold/10 text-gold border border-gold/30 select-none"
      aria-label={title}
    >
      Beta
    </span>
  );
}
