import { useQuery } from '@tanstack/react-query';
import { apiGet, ApiError } from '../lib/fetchClient';

export interface RecipientWant {
  familyId: string;
  qty: number;
  restriction: { mode: 'any' } | { mode: 'restricted'; variants: string[] };
  isPriority?: boolean;
}

export interface RecipientAvailable {
  productId: string;
  qty: number;
}

export interface RecipientProfile {
  user: {
    username: string;
    handle: string;
    avatarUrl: string | null;
  };
  wants: RecipientWant[] | null;
  available: RecipientAvailable[] | null;
}

/**
 * Public profile read for `/u/:handle`. Null `wants`/`available`
 * means the field is private; empty array means public but empty.
 * Same shape as v1's /api/user/:handle.
 */
export function useRecipientProfile(handle: string | undefined) {
  return useQuery<RecipientProfile, ApiError>({
    queryKey: ['user', handle],
    queryFn: () => apiGet<RecipientProfile>(`/api/user/${encodeURIComponent(handle!)}`),
    enabled: !!handle,
    staleTime: 60_000,
  });
}
