import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getIronSession, type SessionOptions } from 'iron-session';

export interface SessionData {
  userId: string;
  username: string;
  handle: string;
  avatarUrl: string | null;
  /** True when the signed-in user is a ghost minted for an
   *  anonymous session claim. Ghosts have no Discord backing; the UI
   *  uses this to render the "Sign in to save this trade" CTA and
   *  to suppress community-feature surfaces that don't apply. */
  isAnonymous?: boolean;
  // Phase 4: Discord OAuth access token, persisted so the user can
  // re-sync their guild memberships without a full re-auth. Stored
  // in the iron-session encrypted cookie — never hits the DB. Expires
  // per Discord's token TTL (7 days by default); endpoints that need
  // it should treat expiry as a non-fatal signal and ask the user to
  // re-auth only if they explicitly requested a Discord-backed action.
  discordAccessToken?: string;
  discordAccessTokenExpiresAt?: number;
  /** UX-A5: set by the OAuth callback when a ghost→real merge moved
   *  at least one session row. Frontend reads this via /api/auth/me
   *  and renders a one-shot reassurance banner ("We carried your
   *  trade over"); dismissing via /api/auth/dismiss-merge-banner
   *  clears it. Persists in the iron-session cookie until dismissed
   *  or the cookie expires — if the user closes the tab without
   *  seeing the banner, it re-appears on next visit. */
  pendingMergeBanner?: { carriedCount: number };
  /** Unix ms when the cookie was last re-saved by getSession's
   *  rolling-refresh path. We slide the maxAge window at most once
   *  per ROLLING_REFRESH_INTERVAL_MS so an active user effectively
   *  never gets signed out, without writing Set-Cookie on every
   *  request. */
  lastRefreshedAt?: number;
}

/** 1 year. Combined with the rolling refresh in `getSession`, an
 *  active user's cookie window keeps sliding forward — only a user
 *  who goes fully dark for a year hits the absolute expiry. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Minimum gap between rolling-refresh writes. Once per day is plenty
 *  to keep the maxAge window sliding, while bounding Set-Cookie churn
 *  on chatty endpoints (e.g., polling /api/auth/me). */
const ROLLING_REFRESH_INTERVAL_MS = 1000 * 60 * 60 * 24;

function getSessionOptions(): SessionOptions {
  return {
    password: process.env.SESSION_SECRET!,
    cookieName: 'swu_session',
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: '/',
    },
  };
}

export async function getSession(
  req: VercelRequest,
  res: VercelResponse,
): Promise<SessionData | null> {
  const session = await getIronSession<SessionData>(req, res, getSessionOptions());
  if (!session.userId) return null;

  // Rolling refresh: slide the cookie's maxAge window forward when
  // enough time has passed since the last save. iron-session writes
  // an absolute Expires date into the cookie at save() time, so an
  // untouched session would otherwise hit SESSION_MAX_AGE_SECONDS
  // after issue regardless of activity.
  const now = Date.now();
  const lastRefreshedAt = session.lastRefreshedAt ?? 0;
  if (now - lastRefreshedAt > ROLLING_REFRESH_INTERVAL_MS) {
    session.lastRefreshedAt = now;
    await session.save();
  }

  return {
    userId: session.userId,
    username: session.username,
    handle: session.handle,
    avatarUrl: session.avatarUrl,
    isAnonymous: session.isAnonymous ?? false,
    discordAccessToken: session.discordAccessToken,
    discordAccessTokenExpiresAt: session.discordAccessTokenExpiresAt,
    pendingMergeBanner: session.pendingMergeBanner,
  };
}

export async function createSession(
  req: VercelRequest,
  res: VercelResponse,
  data: SessionData,
): Promise<void> {
  const session = await getIronSession<SessionData>(req, res, getSessionOptions());
  session.userId = data.userId;
  session.username = data.username;
  session.handle = data.handle;
  session.avatarUrl = data.avatarUrl;
  session.isAnonymous = data.isAnonymous ?? false;
  session.discordAccessToken = data.discordAccessToken;
  session.discordAccessTokenExpiresAt = data.discordAccessTokenExpiresAt;
  if (data.pendingMergeBanner) session.pendingMergeBanner = data.pendingMergeBanner;
  session.lastRefreshedAt = Date.now();
  await session.save();
}

/**
 * UX-A5: update an existing session's `pendingMergeBanner` slot
 * without rebuilding the whole session (keeps identity + tokens
 * intact). Set to a count to flag the banner; pass `null` to clear
 * after the user dismisses.
 */
export async function setPendingMergeBanner(
  req: VercelRequest,
  res: VercelResponse,
  banner: SessionData['pendingMergeBanner'] | null,
): Promise<void> {
  const session = await getIronSession<SessionData>(req, res, getSessionOptions());
  if (!session.userId) return;
  if (banner) {
    session.pendingMergeBanner = banner;
  } else {
    delete session.pendingMergeBanner;
  }
  await session.save();
}

/**
 * Returns the stored Discord OAuth access token if the session has
 * one and it hasn't expired yet. Callers use this to make Discord
 * API calls on behalf of the user (e.g., re-syncing guild list).
 * Returns null on missing/expired — caller decides whether to
 * degrade (e.g., return stale data) or prompt re-auth.
 */
export async function getDiscordAccessToken(
  req: VercelRequest,
  res: VercelResponse,
): Promise<string | null> {
  const session = await getIronSession<SessionData>(req, res, getSessionOptions());
  if (!session.userId || !session.discordAccessToken) return null;
  const expiresAt = session.discordAccessTokenExpiresAt ?? 0;
  if (expiresAt <= Date.now()) return null;
  return session.discordAccessToken;
}

export async function destroySession(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const session = await getIronSession<SessionData>(req, res, getSessionOptions());
  session.destroy();
}

/**
 * Guard for protected API routes. Returns the session data or sends
 * a 401 and returns null — callers should early-return on null.
 */
export async function requireSession(
  req: VercelRequest,
  res: VercelResponse,
): Promise<SessionData | null> {
  const session = await getSession(req, res);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  return session;
}
