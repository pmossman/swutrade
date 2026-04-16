import { useCallback, useEffect, useState } from 'react';
import type { CardVariant, PriceMode, TradeCard } from '../types';
import type { VariantRestriction } from '../persistence';
import { computeMatch } from '../utils/matchmaker';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';

interface AutoBalanceBannerProps {
  senderHandle: string | null;
  isSignedIn: boolean;
  hasCards: boolean;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
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
 * Context-aware "run the matchmaker" prompt. Shows only when a
 * signed-in recipient arrives via ?from=<handle> on an empty trade.
 * A single explicit click runs computeMatch and pre-fills both sides;
 * dismiss or any populated trade hides it.
 *
 * Replaces the always-visible MatchmakerInput. The engine still lives
 * in utils/matchmaker + /api/user/[handle]; this is just the invocation
 * surface, narrowed to the case where it actually has context.
 */
export function AutoBalanceBanner({
  senderHandle,
  isSignedIn,
  hasCards,
  allCards,
  percentage,
  priceMode,
  wants,
  available,
  onApplyMatch,
}: AutoBalanceBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'no-match' | 'error'>('idle');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Reset dismissal when the sender context changes — a new ?from= is
  // a fresh opportunity, not the same one the user declined earlier.
  useEffect(() => {
    setDismissed(false);
    setStatus('idle');
    setSuccessMessage(null);
  }, [senderHandle]);

  const run = useCallback(async () => {
    if (!senderHandle) return;
    setStatus('loading');
    try {
      const res = await fetch(`/api/user/${encodeURIComponent(senderHandle)}`);
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const profile: RemoteProfile = await res.json();
      const result = computeMatch(
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
      if (result.offering.length === 0 && result.receiving.length === 0) {
        setStatus('no-match');
        return;
      }
      onApplyMatch(
        result.offering.map(c => ({ card: c, qty: 1 })),
        result.receiving.map(c => ({ card: c, qty: 1 })),
      );
      setSuccessMessage(
        `Loaded ${result.offering.length} card${result.offering.length === 1 ? '' : 's'} to offer and ${result.receiving.length} to receive.`,
      );
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }, [senderHandle, wants.items, available.items, allCards, priceMode, percentage, onApplyMatch]);

  if (!isSignedIn) return null;
  if (!senderHandle) return null;
  if (dismissed) return null;
  // Don't interrupt an in-progress trade with an auto-balance prompt.
  // The success toast keeps showing even after cards land.
  if (hasCards && !successMessage) return null;

  return (
    <div className="px-3 pb-2 max-w-5xl mx-auto w-full">
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gold/10 border border-gold/30 text-xs text-gray-200">
        {status === 'loading' ? (
          <span className="flex-1 text-gold animate-pulse">
            Building a balanced trade with @{senderHandle}…
          </span>
        ) : status === 'no-match' ? (
          <span className="flex-1 text-gray-400">
            No card overlap with @{senderHandle} yet — add wants or available cards first.
          </span>
        ) : status === 'error' ? (
          <span className="flex-1 text-red-300">
            Couldn't reach @{senderHandle}'s lists. Try again.
          </span>
        ) : successMessage ? (
          <span className="flex-1 text-gold">{successMessage}</span>
        ) : (
          <>
            <span className="flex-1">
              Auto-balance a trade with <strong className="text-gold">@{senderHandle}</strong>?
            </span>
            <button
              type="button"
              onClick={run}
              className="px-2.5 py-1 rounded-md bg-gold/20 border border-gold/40 text-gold text-[11px] font-bold hover:bg-gold/30 hover:border-gold/60 transition-colors"
            >
              Auto-balance
            </button>
          </>
        )}
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
