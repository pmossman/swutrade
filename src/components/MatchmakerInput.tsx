import { useState, useCallback } from 'react';
import type { CardVariant, PriceMode, TradeCard } from '../types';
import type { VariantRestriction } from '../persistence';
import { computeMatch } from '../utils/matchmaker';
import { useAuthContext } from '../contexts/AuthContext';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';

interface MatchmakerInputProps {
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
  wants: WantsApi;
  available: AvailableApi;
  onApplyMatch: (yourCards: TradeCard[], theirCards: TradeCard[]) => void;
  /** Optional handle to pre-populate the input — used when a signed-in
   *  user opens a ?from=<handle> link. They can click Find trade
   *  directly without retyping the handle. */
  initialHandle?: string;
}

interface RemoteProfile {
  user: { username: string; handle: string; avatarUrl: string | null };
  wants: Array<{ familyId: string; qty: number; restriction: VariantRestriction; isPriority?: boolean }> | null;
  available: Array<{ productId: string; qty: number }> | null;
}

export function MatchmakerInput({
  allCards,
  percentage,
  priceMode,
  wants,
  available,
  onApplyMatch,
  initialHandle,
}: MatchmakerInputProps) {
  const { user } = useAuthContext();
  // Read ?from= off the URL as a fallback to the explicit prop so a
  // Profile → Start a trade hop (which pushes ?from=<handle> to the
  // URL immediately before this component mounts for the first time)
  // still pre-populates. The App-level useSenderHandle latches on
  // App mount, before the URL gains ?from=, so we can't rely on it
  // alone here.
  const [handle, setHandle] = useState(() => {
    if (initialHandle) return initialHandle;
    if (typeof window === 'undefined') return '';
    const params = new URLSearchParams(window.location.search);
    return params.get('from')?.trim().replace(/^@/, '') ?? '';
  });
  const [status, setStatus] = useState<'idle' | 'loading' | 'no-match' | 'error'>('idle');
  const [matchInfo, setMatchInfo] = useState<{
    username: string;
    overlapOffering: number;
    overlapReceiving: number;
    offeringTotal: number;
    receivingTotal: number;
  } | null>(null);
  const [lastSearchedHandle, setLastSearchedHandle] = useState<string | null>(null);

  const findMatch = useCallback(async () => {
    const trimmed = handle.trim().replace(/^@/, '');
    if (!trimmed) return;

    setStatus('loading');
    setMatchInfo(null);

    try {
      const res = await fetch(`/api/user/${encodeURIComponent(trimmed)}`);
      if (res.status === 404) {
        setStatus('error');
        return;
      }
      if (!res.ok) throw new Error();
      const profile: RemoteProfile = await res.json();

      setLastSearchedHandle(profile.user.handle);

      if (!profile.wants && !profile.available) {
        setStatus('no-match');
        return;
      }

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

      setMatchInfo({
        username: profile.user.username,
        overlapOffering: result.overlapOffering,
        overlapReceiving: result.overlapReceiving,
        offeringTotal: result.offeringTotal,
        receivingTotal: result.receivingTotal,
      });
      setStatus('idle');

      onApplyMatch(
        result.offering.map(c => ({ card: c, qty: 1 })),
        result.receiving.map(c => ({ card: c, qty: 1 })),
      );
    } catch {
      setStatus('error');
    }
  }, [handle, wants.items, available.items, allCards, priceMode, percentage, onApplyMatch]);

  if (!user) return null;

  const selfEmpty = wants.items.length === 0 && available.items.length === 0;

  return (
    <div className="flex flex-col gap-2 px-3 pb-3 max-w-5xl mx-auto w-full">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={handle}
            onChange={e => setHandle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && findMatch()}
            placeholder="Enter @handle to find a trade…"
            className="w-full px-3 py-2 rounded-lg bg-space-800 border border-space-700 focus:border-gold/50 focus:outline-none text-sm text-gray-100 placeholder:text-gray-600"
          />
        </div>
        <button
          type="button"
          onClick={findMatch}
          disabled={!handle.trim() || status === 'loading'}
          className="px-4 py-2 rounded-lg bg-gold/15 border border-gold/40 text-gold text-sm font-bold hover:bg-gold/25 hover:border-gold/60 transition-colors disabled:opacity-40"
        >
          {status === 'loading' ? 'Finding…' : 'Find trade'}
        </button>
      </div>
      {status === 'no-match' && (
        <div className="text-xs text-gray-500 px-1">
          {selfEmpty ? (
            <>
              Save wants or available cards in <strong className="text-gray-300">My Lists</strong> to match against this user.
              {lastSearchedHandle && (
                <>
                  {' '}
                  <a
                    href={`/?profile=${encodeURIComponent(lastSearchedHandle)}`}
                    className="text-gold hover:text-gold-bright underline"
                  >
                    View @{lastSearchedHandle}'s profile
                  </a>
                  {' '}in the meantime.
                </>
              )}
            </>
          ) : (
            <>
              No card overlap found — you and this user don't have matching wants/available.
              {lastSearchedHandle && (
                <>
                  {' '}
                  <a
                    href={`/?profile=${encodeURIComponent(lastSearchedHandle)}`}
                    className="text-gold hover:text-gold-bright underline"
                  >
                    View their profile
                  </a>
                </>
              )}
            </>
          )}
        </div>
      )}
      {status === 'error' && (
        <div className="text-xs text-red-400 px-1">
          User not found. Check the handle and try again.
        </div>
      )}
      {matchInfo && (
        <div className="text-xs text-gold px-1">
          Found a trade with {matchInfo.username}: {matchInfo.overlapOffering} card{matchInfo.overlapOffering !== 1 ? 's' : ''} you can offer, {matchInfo.overlapReceiving} you can receive. Trade pre-loaded above.
        </div>
      )}
    </div>
  );
}
