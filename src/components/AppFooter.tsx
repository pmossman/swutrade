import { APP_COMMIT, APP_BUILD_TIME, isBetaChannel } from '../version';
import { relativeTime } from '../utils/relativeTime';
import { useAuthContext } from '../contexts/AuthContext';
import { usePriceDataContext } from '../contexts/PriceDataContext';
import type { SyncStatus } from '../hooks/useServerSync';
import { LoadingState } from './ui/states';

interface AppFooterProps {
  /** Surfaced as a small "Syncing…" / "Sync error" / "Offline" tail
   *  in the footer when non-idle. Pulled from useServerSync at the
   *  App root, threaded down so the footer doesn't subscribe twice. */
  syncStatus: SyncStatus;
}

/**
 * Footer one-liner — author + price source + price freshness +
 * version + sync status. Designed as a `shrink-0` flex item so it
 * sits at the bottom of a 100dvh column layout on the trade
 * builder, and at the bottom of a min-h-100dvh container on every
 * other view (Home, Settings, Community, etc.).
 *
 * Renders the desktop legal/attribution blurb inline below the
 * one-liner (md:block). Mobile legal goes in the separate
 * `<MobileLegalDisclaimer />` component, deliberately rendered
 * AFTER the 100dvh container so it sits below the initial viewport
 * — users scroll down to see it without it eating main vertical
 * space.
 */
export function AppFooter({ syncStatus }: AppFooterProps) {
  const auth = useAuthContext();
  const priceData = usePriceDataContext();
  const user = auth.user;

  return (
    <div className="shrink-0 pb-2 px-3 text-center text-[10px] text-gray-600 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-center gap-2 flex-wrap">
        <span>
          Created by{' '}
          <a
            href="https://discord.com/users/pmoss"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-gold transition-colors underline"
          >
            @pmoss
          </a>
        </span>
        <span className="text-space-600" aria-hidden>·</span>
        <span>
          Prices from{' '}
          <a
            href="https://www.tcgplayer.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-gold transition-colors underline"
          >
            TCGPlayer
          </a>
        </span>
        {priceData.isAnyLoading ? (
          <>
            <span className="text-space-600" aria-hidden>·</span>
            <LoadingState inline label="Loading prices…" />
          </>
        ) : priceData.priceTimestamp && (
          <>
            <span className="text-space-600" aria-hidden>·</span>
            <span title={`Prices updated ${priceData.priceTimestamp}`}>
              Prices updated {relativeTime(priceData.priceTimestamp)}
            </span>
          </>
        )}
        <span className="text-space-600" aria-hidden>·</span>
        <span
          title={`Built ${new Date(APP_BUILD_TIME).toLocaleString()}`}
          className={isBetaChannel() ? 'text-gold/70' : 'text-gray-500'}
        >
          {isBetaChannel() ? 'beta' : 'v'}&nbsp;{APP_COMMIT}
          {isBetaChannel() && (
            <span className="text-gold/40"> · built {relativeTime(APP_BUILD_TIME)}</span>
          )}
        </span>
        {user && syncStatus !== 'idle' && (
          <>
            <span className="text-space-600" aria-hidden>·</span>
            <span className={
              syncStatus === 'syncing' ? 'text-gold/70 animate-pulse' :
              syncStatus === 'error' ? 'text-red-400' :
              syncStatus === 'offline' ? 'text-gray-600' : 'text-gray-500'
            }>
              {syncStatus === 'syncing' ? 'Syncing…' :
               syncStatus === 'error' ? 'Sync error' :
               syncStatus === 'offline' ? 'Offline' : ''}
            </span>
          </>
        )}
      </div>
      {/* Legal/attribution line — visible inline on desktop, but
          pushed below the fold on mobile so we don't eat the main
          vertical space. Scroll down on mobile to read it (see
          <MobileLegalDisclaimer />). */}
      <div className="hidden md:block mt-1.5 text-[9px] text-gray-700 leading-snug px-2">
        SWUTrade is an unofficial fan site, not produced or endorsed by Fantasy Flight Publishing or Lucasfilm Ltd.
        Card images and Star Wars: Unlimited game assets © Fantasy Flight Publishing Inc. and Lucasfilm Ltd.
        Card prices are estimates — see stores for final pricing.
      </div>
    </div>
  );
}

/**
 * Mobile-only legal disclaimer. Render AFTER the main 100dvh
 * container so it lives below the initial viewport on mobile —
 * users have to scroll down to see it, which keeps the legal text
 * out of the main app's screen real-estate budget.
 */
export function MobileLegalDisclaimer() {
  return (
    <div className="md:hidden bg-space-900 text-gray-700 text-[10px] leading-snug px-4 py-4 text-center">
      SWUTrade is an unofficial fan site, not produced or endorsed by Fantasy Flight Publishing or Lucasfilm Ltd.
      Card images and Star Wars: Unlimited game assets © Fantasy Flight Publishing Inc. and Lucasfilm Ltd.
      Card prices are estimates — see stores for final pricing.
    </div>
  );
}
