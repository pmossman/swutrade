import { useCallback, useEffect, useState } from 'react';

/**
 * One row in the CommunityView directory. Shape mirrors the server
 * response — all overlap computation happens in the component so
 * the hook stays thin and testable independently.
 */
export type PrefValue = boolean | string | null;

export interface PeerPrefs {
  /** Raw override value from user_peer_prefs. null = "no override". */
  override: Record<string, PrefValue>;
  /** What resolvePref would return (override → viewer self → default). */
  effective: Record<string, PrefValue>;
}

export interface CommunityMember {
  userId: string;
  handle: string;
  username: string;
  avatarUrl: string | null;
  mutualGuildNames: string[];
  wantsPublic: boolean;
  availablePublic: boolean;
  wantsTotal: number;
  availableTotal: number;
  /** Populated only when wantsPublic is true. */
  wantFamilyIds: string[];
  /** Populated only when availablePublic is true. */
  availableProductIds: string[];
  peerPrefs: PeerPrefs;
}

export interface CommunityMembersApi {
  members: CommunityMember[];
  status: 'loading' | 'ready' | 'error';
  /** Set a peer-scoped pref override for a specific member. Pass
   *  `value: null` to clear the override (falls back to self). */
  setPeerPref: (peerUserId: string, key: string, value: PrefValue) => Promise<void>;
}

/**
 * Fetches per-user community data from `/api/me/community-members`.
 * Runs once on mount; callers that need a refresh should unmount
 * + remount (the view navigation already does this).
 */
export function useCommunityMembers(): CommunityMembersApi {
  const [members, setMembers] = useState<CommunityMember[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/me/community-members');
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: { members: CommunityMember[] } = await res.json();
        if (cancelled) return;
        setMembers(data.members);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Optimistic update: flip the in-memory override + effective for
  // the target member before the PUT round-trips. On failure, refetch
  // the whole list rather than trying to reverse each modification —
  // the directory isn't huge and consistency beats cleverness.
  const setPeerPref = useCallback<CommunityMembersApi['setPeerPref']>(async (peerUserId, key, value) => {
    setMembers(prev => prev.map(m => {
      if (m.userId !== peerUserId) return m;
      const nextOverride = { ...m.peerPrefs.override, [key]: value };
      const nextEffective = {
        ...m.peerPrefs.effective,
        // When value is null, we don't know the self fallback from
        // the client — leave the previous effective value in place
        // until the refetch below settles it. For a concrete new
        // value, effective equals the override.
        [key]: value ?? m.peerPrefs.effective[key] ?? null,
      };
      return { ...m, peerPrefs: { override: nextOverride, effective: nextEffective } };
    }));

    try {
      const res = await fetch('/api/me/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peerUserId, key, value }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      // If we cleared an override (value = null), refetch to pick up
      // the authoritative effective value from the server's cascade.
      if (value === null) {
        const refreshed = await fetch('/api/me/community-members');
        if (refreshed.ok) {
          const data: { members: CommunityMember[] } = await refreshed.json();
          setMembers(data.members);
        }
      }
    } catch {
      // Roll back by refetching from source of truth.
      const refreshed = await fetch('/api/me/community-members');
      if (refreshed.ok) {
        const data: { members: CommunityMember[] } = await refreshed.json();
        setMembers(data.members);
      }
    }
  }, []);

  return { members, status, setPeerPref };
}
