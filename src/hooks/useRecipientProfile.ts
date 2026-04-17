import { useEffect, useRef, useState } from 'react';
import type { VariantRestriction } from '../persistence';

export interface RecipientProfile {
  user: { username: string; handle: string; avatarUrl: string | null };
  wants: Array<{ familyId: string; qty: number; restriction: VariantRestriction; isPriority?: boolean }> | null;
  available: Array<{ productId: string; qty: number }> | null;
}

export type FetchState = 'idle' | 'loading' | 'error';

/**
 * Fetches `/api/user/<handle>` and returns the recipient's public
 * lists for the propose flow. Centralized so both ProposeBar (for
 * the matchmaker + status line) and TradeSide (for scoped picker
 * source-chip pools) read the same snapshot instead of each doing
 * their own fetch.
 *
 * Uses a ref-based dedupe guard to avoid the "state-in-deps" effect
 * trap flagged in PHASE4_TESTING.md — changing fetch state inside
 * an effect that had fetch state in its deps would cancel itself.
 */
export function useRecipientProfile(handle: string | null): {
  profile: RecipientProfile | null;
  fetchState: FetchState;
} {
  const [profile, setProfile] = useState<RecipientProfile | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>('idle');
  const fetchStartedForRef = useRef<string | null>(null);

  useEffect(() => {
    // Reset when handle changes (including changing to null).
    setProfile(null);
    fetchStartedForRef.current = null;
    if (!handle) {
      setFetchState('idle');
      return;
    }
    if (fetchStartedForRef.current === handle) return;
    fetchStartedForRef.current = handle;

    let cancelled = false;
    setFetchState('loading');
    (async () => {
      try {
        const res = await fetch(`/api/user/${encodeURIComponent(handle)}`);
        if (cancelled) return;
        if (!res.ok) {
          setFetchState('error');
          return;
        }
        const data: RecipientProfile = await res.json();
        if (cancelled) return;
        setProfile(data);
        setFetchState('idle');
      } catch {
        if (!cancelled) setFetchState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [handle]);

  return { profile, fetchState };
}
