import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardVariant, TradeCard } from '../types';
import type { VariantRestriction } from '../persistence';
import { computeMatch, type MatchResult } from '../utils/matchmaker';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import { usePricing } from '../contexts/PricingContext';

interface AutoBalanceBannerProps {
  senderHandle: string | null;
  isSignedIn: boolean;
  hasCards: boolean;
  allCards: CardVariant[];
  wants: WantsApi;
  available: AvailableApi;
  onApplyMatch: (yours: TradeCard[], theirs: TradeCard[]) => void;
}

interface RemoteProfile {
  user: { username: string; handle: string; avatarUrl: string | null };
  wants: Array<{ familyId: string; qty: number; restriction: VariantRestriction; isPriority?: boolean }> | null;
  available: Array<{ productId: string; qty: number }> | null;
}

/**
 * Context-aware "run the matchmaker" prompt. Surfaces only when a
 * signed-in recipient arrives via ?from=<handle> on an empty trade.
 *
 * Behaviour:
 *   - Fetches the sender's public lists once per senderHandle and
 *     derives a speculative match from current state, so the prompt
 *     shows the real overlap ("3 cards you can trade with @alice")
 *     before the user commits. The derivation is a useMemo, not an
 *     effect — it recomputes cleanly when lists/settings change
 *     without fighting an in-flight fetch.
 *   - If the URL also carries ?autoBalance=1 (set by ProfileView's
 *     Start-a-trade handoff), the match is applied automatically
 *     once the preview is ready, and the flag is stripped so reloads
 *     and share URLs stay clean. The shared-list flow (?from= alone,
 *     no autoBalance) keeps the explicit prompt.
 *   - Dismissable per sender. Hides once any cards are in the trade.
 */
export function AutoBalanceBanner({
  senderHandle,
  isSignedIn,
  hasCards,
  allCards,
  wants,
  available,
  onApplyMatch,
}: AutoBalanceBannerProps) {
  const { percentage, priceMode } = usePricing();
  const [dismissed, setDismissed] = useState(false);
  const [profile, setProfile] = useState<RemoteProfile | null>(null);
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [appliedCounts, setAppliedCounts] = useState<{ off: number; rec: number } | null>(null);
  const autoAppliedRef = useRef(false);
  // Capture ?autoBalance=1 in the initial render via useState lazy
  // init — useTradeUrl's sync effect strips the param from the URL
  // shortly after mount, so reading `window.location.href` from a
  // post-mount useEffect would always see autoBalance as absent.
  const [autoBalanceRequested] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('autoBalance') === '1';
  });
  // Guards against the "state-in-deps" useEffect trap: we set
  // fetchState inside the effect that previously had fetchState
  // in its dep array, so the cleanup fired (setting cancelled=true)
  // before our own fetch could resolve. Dedupe via a ref that's
  // reset along with the other state when senderHandle changes.
  const fetchStartedRef = useRef(false);

  // Reset everything when the sender context changes.
  useEffect(() => {
    setDismissed(false);
    setProfile(null);
    setFetchState('idle');
    setAppliedCounts(null);
    autoAppliedRef.current = false;
    fetchStartedRef.current = false;
  }, [senderHandle]);

  // One-shot profile fetch per senderHandle. Dep array is
  // deliberately only identity/gating values — nothing the effect
  // itself mutates. fetchStartedRef prevents duplicate concurrent
  // fetches within one senderHandle lifecycle.
  useEffect(() => {
    if (!isSignedIn || !senderHandle || dismissed) return;
    if (fetchStartedRef.current) return;
    fetchStartedRef.current = true;

    let cancelled = false;
    setFetchState('loading');

    (async () => {
      try {
        const res = await fetch(`/api/user/${encodeURIComponent(senderHandle)}`);
        if (cancelled) return;
        if (!res.ok) {
          setFetchState('error');
          return;
        }
        const data: RemoteProfile = await res.json();
        if (cancelled) return;
        setProfile(data);
        setFetchState('idle');
      } catch {
        if (!cancelled) setFetchState('error');
      }
    })();

    return () => { cancelled = true; };
  }, [isSignedIn, senderHandle, dismissed]);

  // Derived preview — recomputes whenever lists or settings shift.
  // Pure function, cheap; no async dance to manage.
  const preview = useMemo<MatchResult | null>(() => {
    if (!profile) return null;
    if (allCards.length === 0) return null;
    return computeMatch(
      wants.items.map(w => ({
        familyId: w.familyId,
        qty: w.qty,
        restriction: w.restriction,
        isPriority: w.isPriority,
      })),
      available.items.map(a => ({ productId: a.productId, qty: a.qty })),
      profile.wants ?? [],
      profile.available ?? [],
      allCards,
      priceMode,
      percentage,
    );
  }, [profile, allCards, percentage, priceMode, wants.items, available.items]);

  const applyResult = useCallback((result: MatchResult) => {
    onApplyMatch(
      result.offering.map(c => ({ card: c, qty: 1 })),
      result.receiving.map(c => ({ card: c, qty: 1 })),
    );
    setAppliedCounts({ off: result.offering.length, rec: result.receiving.length });
  }, [onApplyMatch]);

  // Auto-apply once: profile resolved, preview non-empty, and the
  // URL flag was present at mount (captured above in useState).
  useEffect(() => {
    if (!autoBalanceRequested) return;
    if (autoAppliedRef.current || !preview) return;
    if (preview.offering.length === 0 && preview.receiving.length === 0) return;

    autoAppliedRef.current = true;
    // Scrub the flag from the live URL if anything left it behind,
    // so a reload won't re-trigger and share copies stay clean.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (url.searchParams.has('autoBalance')) {
        url.searchParams.delete('autoBalance');
        window.history.replaceState(null, '', url.toString());
      }
    }
    applyResult(preview);
  }, [autoBalanceRequested, preview, applyResult]);

  if (!isSignedIn) return null;
  if (!senderHandle) return null;
  if (dismissed) return null;
  if (hasCards && !appliedCounts) return null;

  const body = (() => {
    if (appliedCounts) {
      return (
        <span className="flex-1 text-gold">
          Loaded {appliedCounts.off} card{appliedCounts.off === 1 ? '' : 's'} to offer and {appliedCounts.rec} to receive.
        </span>
      );
    }

    if (fetchState === 'error') {
      return (
        <span className="flex-1 text-red-300">
          Couldn't reach @{senderHandle}'s lists. Try again.
        </span>
      );
    }

    if (!preview) {
      return (
        <span className="flex-1 text-gray-400 animate-pulse">
          Checking what you could trade with @{senderHandle}…
        </span>
      );
    }

    if (preview.offering.length === 0 && preview.receiving.length === 0) {
      return (
        <span className="flex-1 text-gray-400">
          No card overlap with @{senderHandle} yet — add wants or available cards first.
        </span>
      );
    }

    const { offering, receiving } = preview;
    const label = offering.length > 0 && receiving.length > 0
      ? <>Trade preview: offer <strong className="text-emerald-300">{offering.length}</strong>, receive <strong className="text-blue-300">{receiving.length}</strong></>
      : offering.length > 0
        ? <>You could offer <strong className="text-emerald-300">{offering.length}</strong> card{offering.length === 1 ? '' : 's'} @{senderHandle} wants</>
        : <>@{senderHandle} has <strong className="text-blue-300">{receiving.length}</strong> card{receiving.length === 1 ? '' : 's'} you want</>;

    return (
      <>
        <span className="flex-1">{label}</span>
        <button
          type="button"
          onClick={() => applyResult(preview)}
          className="px-2.5 py-1 rounded-md bg-gold/20 border border-gold/40 text-gold text-[11px] font-bold hover:bg-gold/30 hover:border-gold/60 transition-colors"
        >
          Load trade
        </button>
      </>
    );
  })();

  // Expose internal state as a data attribute so traces + future
  // e2e tests have a deterministic signal independent of copy.
  // Kept after the flaky-test debugging session — it's a cheap win
  // the next time a state-machine bug shows up.
  const debugState = appliedCounts
    ? 'applied'
    : fetchState === 'error'
      ? 'error'
      : !profile
        ? 'loading-profile'
        : !preview
          ? 'loading-compute'
          : preview.offering.length === 0 && preview.receiving.length === 0
            ? 'no-match'
            : 'preview';

  return (
    <div className="px-3 pb-2 max-w-5xl mx-auto w-full" data-testid="auto-balance-banner" data-state={debugState}>
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gold/10 border border-gold/30 text-xs text-gray-200">
        {body}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="shrink-0 text-gray-500 hover:text-gray-200 transition-colors"
        >
          <CloseIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M4 4L12 12M4 12L12 4" />
    </svg>
  );
}
