import { useEffect, useState } from 'react';

export interface CommunityCardsApi {
  /** familyIds at least one other enrolled community member wants. */
  wantFamilyIds: string[];
  /** productIds at least one other enrolled community member has available. */
  availableProductIds: string[];
  status: 'loading' | 'ready' | 'empty' | 'error';
}

/**
 * Fetches `/api/me/community` for the signed-in user. Returns the
 * raw id lists — callers resolve them against their card index to
 * build UI (e.g. TradeSide's community source chip). Gated on being
 * signed in: when `isSignedIn` is false we skip the fetch entirely
 * and stay in `empty` so downstream UI can hide cleanly.
 */
export function useCommunityCards(isSignedIn: boolean): CommunityCardsApi {
  const [wantFamilyIds, setWantFamilyIds] = useState<string[]>([]);
  const [availableProductIds, setAvailableProductIds] = useState<string[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>(
    isSignedIn ? 'loading' : 'empty',
  );

  useEffect(() => {
    if (!isSignedIn) {
      setWantFamilyIds([]);
      setAvailableProductIds([]);
      setStatus('empty');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    fetch('/api/me/community')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data: { wantFamilyIds?: string[]; availableProductIds?: string[] }) => {
        if (cancelled) return;
        const wants = data.wantFamilyIds ?? [];
        const avail = data.availableProductIds ?? [];
        setWantFamilyIds(wants);
        setAvailableProductIds(avail);
        setStatus(wants.length === 0 && avail.length === 0 ? 'empty' : 'ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, [isSignedIn]);

  return { wantFamilyIds, availableProductIds, status };
}
