import { useState, useEffect, useCallback, useMemo } from 'react';
import { apiGet, apiPost } from '../services/apiClient';
import { MeResponseSchema, type MeResponseUser } from '../../lib/shared';
import { clearAllPersistentCaches } from './sharedCache';

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
   * builder on first paint before `/api/auth/me` resolves. Includes
   * ghost cookies (per the wide hint).
   *
   * Source of truth remains the server; the hint is advisory only.
   */
  isSignedIn: boolean;
  /**
   * Tighter pre-seed: best current guess at "real user (non-ghost)
   * signed in." Use this (not `isSignedIn`) for first-paint gates
   * that should *not* show ghosts — e.g. the "Post a signal" tile,
   * which requires Discord identity. Pre-seeded by a separate
   * realUserHint localStorage flag set after `/api/auth/me` confirms
   * `!user.isAnonymous`. Falls through to the server-confirmed value
   * once auth resolves. */
  isSignedInRealUser: boolean;
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
 * in (real or ghost) on its last successful /api/auth/me". Set after
 * each confirmed auth, cleared on logout or confirmed-not-signed-in
 * responses. Not a trust surface — the server gates every actual
 * call. Purely used to pre-seed the view router so we don't flash
 * the wrong view.
 */
const SIGNED_IN_HINT_KEY = 'swu.signedInHint';

/**
 * Tighter sibling of SIGNED_IN_HINT_KEY: set ONLY when the last
 * successful /api/auth/me confirmed a real (non-ghost) user. Drives
 * `isSignedInRealUser` so first-paint gates that exclude ghosts
 * (e.g. HomeView's "Post a signal" tile) render the right shape on
 * frame 1 for returning real users instead of popping in 200-300ms
 * later when the auth round-trip completes. Cleared on logout or any
 * confirmed-ghost / confirmed-signed-out response. */
const REAL_USER_HINT_KEY = 'swu.realUserHint';

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

function readRealUserHint(): boolean {
  try {
    return localStorage.getItem(REAL_USER_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function writeRealUserHint(value: boolean): void {
  try {
    if (value) localStorage.setItem(REAL_USER_HINT_KEY, '1');
    else localStorage.removeItem(REAL_USER_HINT_KEY);
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
  // Read once on mount — the hints exist to steer the very first
  // render. After `isLoading` flips false, `!!user` drives isSignedIn
  // and these initial values no longer matter.
  const [initialHint] = useState<boolean>(() => readHint());
  const [initialRealUserHint] = useState<boolean>(() => readRealUserHint());

  useEffect(() => {
    (async () => {
      // Pass MeResponseSchema so the wire shape is validated at the
      // boundary — drift produces a typed `error` reason instead of
      // a runtime crash deep in the consumer (audit
      // 08-types-deadcode #2). useAuth is the proof-of-pattern;
      // other apiGet call sites can opt in opportunistically.
      const result = await apiGet('/api/auth/me', MeResponseSchema);
      if (result.ok) {
        const u = result.data.user ?? null;
        setUser(u);
        setBotInstallUrl(result.data.botInstallUrl ?? null);
        setPendingMergeBanner(result.data.pendingMergeBanner ?? null);
        writeHint(!!u);
        // Real-user hint is the tighter signal — only set when we
        // confirmed a non-anonymous account. Ghosts get the wide
        // hint but not this one.
        writeRealUserHint(!!u && !u.isAnonymous);
      } else {
        setUser(null);
        setPendingMergeBanner(null);
        writeHint(false);
        writeRealUserHint(false);
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
    writeRealUserHint(false);
    // Wipe every persistent client cache so the next user on this
    // browser doesn't flash the previous user's cached Home modules
    // (myTrades, favorites, guilds) before /api/auth/me round-trips.
    clearAllPersistentCaches();
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
  const isSignedInRealUser =
    (isLoading && initialRealUserHint) || (!!user && !user.isAnonymous);

  // Memoize the returned API so AuthContext consumers don't re-render
  // on every parent re-render (the 60s minute-tick in App.tsx, every
  // useSession setState, etc.). The four useCallback'd functions are
  // already stable; primitives + nullable user/banner are the only
  // identity-changing keys.
  return useMemo<AuthApi>(
    () => ({
      user,
      isLoading,
      isSignedIn,
      isSignedInRealUser,
      botInstallUrl,
      pendingMergeBanner,
      dismissMergeBanner,
      login,
      logout,
    }),
    [
      user,
      isLoading,
      isSignedIn,
      isSignedInRealUser,
      botInstallUrl,
      pendingMergeBanner,
      dismissMergeBanner,
      login,
      logout,
    ],
  );
}
