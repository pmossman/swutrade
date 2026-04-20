import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../lib/fetchClient';

export interface AuthUser {
  id: string;
  username: string;
  handle: string;
  avatarUrl: string | null;
  isAnonymous: boolean;
}

interface AuthMeResponse {
  user: AuthUser | null;
  botInstallUrl: string | null;
}

const HINT_KEY = 'swu.signedInHint';

function readHint(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHint(signedIn: boolean) {
  try {
    if (typeof window === 'undefined') return;
    if (signedIn) window.localStorage.setItem(HINT_KEY, '1');
    else window.localStorage.removeItem(HINT_KEY);
  } catch {
    /* Safari private mode — best-effort */
  }
}

export function useAuth() {
  const query = useQuery<AuthMeResponse, ApiError>({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      const res = await apiGet<AuthMeResponse>('/api/auth/me');
      writeHint(!!res.user);
      return res;
    },
    staleTime: 60_000,
  });

  const user = query.data?.user ?? null;
  const botInstallUrl = query.data?.botInstallUrl ?? null;
  const isLoading = query.isLoading;
  const initialHint = readHint();
  const isSignedIn = !!user || (isLoading && initialHint);

  function login() {
    if (typeof window !== 'undefined') {
      window.location.href = '/api/auth/discord';
    }
  }

  async function logout() {
    try {
      await apiPost('/api/auth/logout');
    } finally {
      writeHint(false);
      await query.refetch();
    }
  }

  return { user, isLoading, isSignedIn, botInstallUrl, login, logout, refetch: query.refetch };
}
