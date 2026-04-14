import { APP_COMMIT, APP_BUILD_TIME, isBetaChannel } from '../version';

interface BetaBadgeProps {
  className?: string;
}

/**
 * Small pill shown on beta/preview builds. Caller controls position via
 * className — usually absolute-positioned as a kicker below the wordmark
 * so the title's natural layout doesn't shift between stable and beta.
 * Hover reveals commit + build time for at-a-glance freshness checks.
 */
export function BetaBadge({ className = '' }: BetaBadgeProps) {
  if (!isBetaChannel()) return null;
  const title = `Beta build ${APP_COMMIT} · ${new Date(APP_BUILD_TIME).toLocaleString()}`;
  return (
    <span
      title={title}
      className={`inline-block text-[9px] font-bold uppercase tracking-[0.18em] leading-none text-gold/70 select-none ${className}`}
      aria-label={title}
    >
      Beta
    </span>
  );
}
