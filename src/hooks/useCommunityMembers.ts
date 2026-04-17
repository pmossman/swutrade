import { useEffect, useState } from 'react';

/**
 * One row in the CommunityView directory. Shape mirrors the server
 * response — all overlap computation happens in the component so
 * the hook stays thin and testable independently.
 */
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
}

export interface CommunityMembersApi {
  members: CommunityMember[];
  status: 'loading' | 'ready' | 'error';
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

  return { members, status };
}
