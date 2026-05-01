import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPut } from '../services/apiClient';

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
  /** Guild ids parallel to `mutualGuildNames`. Used by the Settings
   *  page's per-guild members sub-route to filter the directory. */
  mutualGuildIds: string[];
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

  // Per-call generation counter for setPeerPref — same race shape
  // as useGuildMemberships.updateGuild (audit 13-mutation-patterns
  // #1). Without this, two PUTs to /me/prefs in quick succession
  // race; the rollback re-fetch is a fourth in-flight request that
  // can land on top of newer optimistic state.
  const setPeerPrefGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await apiGet<{ members: CommunityMember[] }>(
        '/api/me/community-members',
      );
      if (cancelled) return;
      if (!result.ok) {
        setStatus('error');
        return;
      }
      setMembers(result.data.members);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, []);

  // Optimistic update: flip the in-memory override + effective for
  // the target member before the PUT round-trips. On failure, refetch
  // the whole list rather than trying to reverse each modification —
  // the directory isn't huge and consistency beats cleverness.
  const setPeerPref = useCallback<CommunityMembersApi['setPeerPref']>(async (peerUserId, key, value) => {
    const gen = ++setPeerPrefGenerationRef.current;
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

    const result = await apiPut('/api/me/prefs', { peerUserId, key, value });
    // Stale-response guard: a newer setPeerPref started after ours.
    // Drop both the failure-rollback path AND the value-null refetch
    // path — the newer call's state is what the user is seeing.
    if (gen !== setPeerPrefGenerationRef.current) return;

    if (!result.ok) {
      // Roll back by refetching from source of truth.
      const refreshed = await apiGet<{ members: CommunityMember[] }>(
        '/api/me/community-members',
      );
      if (gen !== setPeerPrefGenerationRef.current) return;
      if (refreshed.ok) setMembers(refreshed.data.members);
      return;
    }
    // If we cleared an override (value = null), refetch to pick up
    // the authoritative effective value from the server's cascade.
    if (value === null) {
      const refreshed = await apiGet<{ members: CommunityMember[] }>(
        '/api/me/community-members',
      );
      if (gen !== setPeerPrefGenerationRef.current) return;
      if (refreshed.ok) setMembers(refreshed.data.members);
    }
  }, []);

  return { members, status, setPeerPref };
}
