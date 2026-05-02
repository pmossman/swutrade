import { useEffect, useState } from 'react';
import { apiGet } from '../services/apiClient';
import { createSingletonCache } from './sharedCache';

export interface CommunityCardsApi {
  /** familyIds at least one other enrolled community member wants. */
  wantFamilyIds: string[];
  /** productIds at least one other enrolled community member has available. */
  availableProductIds: string[];
  status: 'loading' | 'ready' | 'empty' | 'error';
}

// Module-scoped cache: TradeSide and other community-aware surfaces
// each call useCommunityCards; without the cache, navigating
// home → trade-builder → home re-fetches `/api/me/community` on
// every mount. Audit 07-performance #5.
interface CommunityCardsCache {
  wantFamilyIds: string[];
  availableProductIds: string[];
}
const cache = createSingletonCache<CommunityCardsCache>();

/** Testing-only: reset the module-scoped cache between test cases. */
export function __resetCommunityCardsCache() {
  cache.clear();
}

/**
 * Fetches `/api/me/community` for the signed-in user. Returns the
 * raw id lists — callers resolve them against their card index to
 * build UI (e.g. TradeSide's community source chip). Gated on being
 * signed in: when `isSignedIn` is false we skip the fetch entirely
 * and stay in `empty` so downstream UI can hide cleanly.
 */
export function useCommunityCards(isSignedIn: boolean): CommunityCardsApi {
  const [wantFamilyIds, setWantFamilyIds] = useState<string[]>(
    () => (isSignedIn ? cache.get()?.wantFamilyIds ?? [] : []),
  );
  const [availableProductIds, setAvailableProductIds] = useState<string[]>(
    () => (isSignedIn ? cache.get()?.availableProductIds ?? [] : []),
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>(() => {
    if (!isSignedIn) return 'empty';
    if (!cache.has()) return 'loading';
    const c = cache.get()!;
    return c.wantFamilyIds.length === 0 && c.availableProductIds.length === 0 ? 'empty' : 'ready';
  });

  useEffect(() => {
    if (!isSignedIn) {
      // Sign-out boundary: drop cached community lists (could be a
      // different user on next sign-in).
      cache.clear();
      setWantFamilyIds([]);
      setAvailableProductIds([]);
      setStatus('empty');
      return;
    }
    let cancelled = false;
    if (!cache.has()) setStatus('loading');
    (async () => {
      const result = await apiGet<{
        wantFamilyIds?: string[];
        availableProductIds?: string[];
      }>('/api/me/community');
      if (cancelled) return;
      if (!result.ok) {
        if (!cache.has()) setStatus('error');
        return;
      }
      const wants = result.data.wantFamilyIds ?? [];
      const avail = result.data.availableProductIds ?? [];
      cache.set({ wantFamilyIds: wants, availableProductIds: avail });
      setWantFamilyIds(wants);
      setAvailableProductIds(avail);
      setStatus(wants.length === 0 && avail.length === 0 ? 'empty' : 'ready');
    })();
    return () => { cancelled = true; };
  }, [isSignedIn]);

  return { wantFamilyIds, availableProductIds, status };
}
