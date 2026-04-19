import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '../services/apiClient';

export interface User {
  id: string;
  username: string;
  handle: string;
  avatarUrl: string | null;
}

export interface AuthApi {
  user: User | null;
  isLoading: boolean;
  /**
   * Best current guess at signed-in state — true when `user` has
   * resolved OR when we're still loading but have a localStorage hint
   * from a prior visit. Use this (not `!!user`) for view-routing
   * decisions so signed-in users don't see a flash of the trade
   * builder on first paint before `/api/auth/me` resolves.
   *
   * Source of truth remains the server; the hint is advisory only.
   */
  isSignedIn: boolean;
  /** OAuth URL that installs SWUTrade's bot in a Discord guild. */
  botInstallUrl: string | null;
  login: () => void;
  logout: () => Promise<void>;
}

/**
 * Presence of this key in localStorage means "this browser was signed
 * in on its last successful /api/auth/me". Set after each confirmed
 * auth, cleared on logout or confirmed-not-signed-in responses. Not a
 * trust surface — the server gates every actual call. Purely used to
 * pre-seed the view router so we don't flash the wrong view.
 */
const SIGNED_IN_HINT_KEY = 'swu.signedInHint';

function readHint(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHint(value: boolean): void {
  try {
    if (value) localStorage.setItem(SIGNED_IN_HINT_KEY, '1');
    else localStorage.removeItem(SIGNED_IN_HINT_KEY);
  } catch {
    /* Private-mode Safari / storage disabled — harmless. */
  }
}

export function useAuth(): AuthApi {
  const [user, setUser] = useState<User | null>(null);
  const [botInstallUrl, setBotInstallUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Read once on mount — the hint exists to steer the very first
  // render. After `isLoading` flips false, `!!user` drives isSignedIn
  // and this initial value no longer matters.
  const [initialHint] = useState<boolean>(() => readHint());

  useEffect(() => {
    (async () => {
      const result = await apiGet<{
        user?: User | null;
        botInstallUrl?: string | null;
      }>('/api/auth/me');
      if (result.ok) {
        setUser(result.data.user ?? null);
        setBotInstallUrl(result.data.botInstallUrl ?? null);
        writeHint(!!result.data.user);
      } else {
        setUser(null);
        writeHint(false);
      }
      setIsLoading(false);
    })();
  }, []);

  const login = useCallback(() => {
    window.location.href = '/api/auth/discord';
  }, []);

  const logout = useCallback(async () => {
    await apiPost('/api/auth/logout');
    setUser(null);
    writeHint(false);
  }, []);

  const isSignedIn = !!user || (isLoading && initialHint);

  return { user, isLoading, isSignedIn, botInstallUrl, login, logout };
}
