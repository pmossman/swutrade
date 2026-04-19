import { useEffect, useState } from 'react';
import { apiGet } from '../services/apiClient';

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
    (async () => {
      const result = await apiGet<{
        wantFamilyIds?: string[];
        availableProductIds?: string[];
      }>('/api/me/community');
      if (cancelled) return;
      if (!result.ok) {
        setStatus('error');
        return;
      }
      const wants = result.data.wantFamilyIds ?? [];
      const avail = result.data.availableProductIds ?? [];
      setWantFamilyIds(wants);
      setAvailableProductIds(avail);
      setStatus(wants.length === 0 && avail.length === 0 ? 'empty' : 'ready');
    })();
    return () => { cancelled = true; };
  }, [isSignedIn]);

  return { wantFamilyIds, availableProductIds, status };
}
