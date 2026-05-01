import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '../services/apiClient';
import type { MeResponse, MeResponseUser } from '../../lib/shared';

// `User` was previously hand-rolled here in parallel with
// `SessionData` (lib/auth.ts) and the wire shape in api/auth.ts.
// All three now derive from `MeResponseUser` in lib/shared.ts.
// Audit 04-auth #5.
export type User = MeResponseUser;

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
  /** UX-A5: when the just-completed OAuth callback merged ghost
   *  sessions into this real-user account, the server flags how many
   *  rows moved over. Frontend renders a one-shot reassurance banner
   *  while non-null; `dismissMergeBanner()` clears it server-side
   *  AND locally so the banner unmounts immediately. Null in steady
   *  state. */
  pendingMergeBanner: { carriedCount: number } | null;
  dismissMergeBanner: () => Promise<void>;
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
  const [pendingMergeBanner, setPendingMergeBanner] = useState<
    { carriedCount: number } | null
  >(null);
  // Read once on mount — the hint exists to steer the very first
  // render. After `isLoading` flips false, `!!user` drives isSignedIn
  // and this initial value no longer matters.
  const [initialHint] = useState<boolean>(() => readHint());

  useEffect(() => {
    (async () => {
      const result = await apiGet<MeResponse>('/api/auth/me');
      if (result.ok) {
        setUser(result.data.user ?? null);
        setBotInstallUrl(result.data.botInstallUrl ?? null);
        setPendingMergeBanner(result.data.pendingMergeBanner ?? null);
        writeHint(!!result.data.user);
      } else {
        setUser(null);
        setPendingMergeBanner(null);
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
    setPendingMergeBanner(null);
    writeHint(false);
  }, []);

  const dismissMergeBanner = useCallback(async () => {
    // Optimistic — clear locally first so the banner unmounts on the
    // next paint without waiting for the round-trip. The endpoint is
    // idempotent so a network failure doesn't leave the client + server
    // out of sync long-term: the next /api/auth/me will reconcile.
    setPendingMergeBanner(null);
    await apiPost('/api/auth/dismiss-merge-banner');
  }, []);

  const isSignedIn = !!user || (isLoading && initialHint);

  return {
    user,
    isLoading,
    isSignedIn,
    botInstallUrl,
    pendingMergeBanner,
    dismissMergeBanner,
    login,
    logout,
  };
}
