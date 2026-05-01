import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Discord, generateState, generateCodeVerifier } from 'arctic';
import { parse, serialize } from 'cookie';
import { eq } from 'drizzle-orm';
import { createSession, destroySession, getSession, setPendingMergeBanner } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import { users } from '../lib/schema.js';
import { mergeGhostIntoRealUser } from '../lib/sessions.js';
import { syncGuildMemberships } from '../lib/guildSync.js';
import type { MeResponse } from '../lib/shared.js';

/**
 * Consolidated /api/auth dispatcher. Four external endpoints
 * (/api/auth/me, /discord, /callback, /logout) all route here via
 * vercel.json rewrites that set `?action=…`. One file instead of
 * four keeps us comfortably under the 12-function Hobby ceiling.
 *
 * Sub-handlers are exported individually so vitest can invoke them
 * directly without going through the dispatcher.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = (req.query.action as string | undefined) ?? '';
  switch (action) {
    case 'me':                    return handleMe(req, res);
    case 'discord':               return handleDiscordStart(req, res);
    case 'callback':              return handleCallback(req, res);
    case 'logout':                return handleLogout(req, res);
    case 'dismiss-merge-banner':  return handleDismissMergeBanner(req, res);
    default:
      return res.status(404).json({ error: 'Unknown /api/auth action' });
  }
}

// --- /api/auth/me -----------------------------------------------------------

export async function handleMe(req: VercelRequest, res: VercelResponse) {
  const session = await getSession(req, res);
  if (!session) {
    const body: MeResponse = { user: null, botInstallUrl: null, pendingMergeBanner: null };
    return res.json(body);
  }
  const body: MeResponse = {
    user: {
      id: session.userId,
      username: session.username,
      handle: session.handle,
      avatarUrl: session.avatarUrl,
      isAnonymous: session.isAnonymous ?? false,
    },
    botInstallUrl: buildBotInstallUrl(),
    // UX-A5: set by the OAuth callback after a ghost→real merge moved
    // at least one session. Frontend renders a one-shot reassurance
    // banner; dismiss posts to /api/auth/dismiss-merge-banner.
    pendingMergeBanner: session.pendingMergeBanner ?? null,
  };
  res.json(body);
}

// --- /api/auth/dismiss-merge-banner ----------------------------------------

/**
 * Clears the `pendingMergeBanner` flag on the caller's session after
 * they've seen + acknowledged the "we carried your trade over"
 * banner. Idempotent — calling on a session without the flag is a
 * no-op 200. 401 when not signed in.
 */
export async function handleDismissMergeBanner(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSession(req, res);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  await setPendingMergeBanner(req, res, null);
  res.json({ ok: true });
}

/**
 * Permissions the bot requests on install. Sum of the following bits:
 *   - VIEW_CHANNEL              (1 << 10) = 1024
 *   - SEND_MESSAGES             (1 << 11) = 2048
 *   - MANAGE_CHANNELS           (1 << 4)  = 16
 *   - MANAGE_THREADS            (1 << 34) = 17179869184
 *   - CREATE_PRIVATE_THREADS    (1 << 36) = 68719476736
 *   - SEND_MESSAGES_IN_THREADS  (1 << 38) = 274877906944
 *
 * MANAGE_CHANNELS is how the bot auto-creates a `#swutrade-threads`
 * parent channel on install; the thread-related bits let it spawn +
 * speak in private threads for each trade proposal.
 */
const BOT_INSTALL_PERMISSIONS = '360777255952';

/**
 * Server-constructed OAuth URL for installing SWUTrade's bot in a
 * Discord guild. Kept server-side so DISCORD_CLIENT_ID isn't shipped
 * in the Vite bundle and so scope/permission changes stay in one
 * place. Permissions integer — see `BOT_INSTALL_PERMISSIONS` above for
 * the bit-by-bit breakdown.
 */
function buildBotInstallUrl(): string | null {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'bot applications.commands',
    permissions: BOT_INSTALL_PERMISSIONS,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

// --- /api/auth/logout -------------------------------------------------------

export async function handleLogout(req: VercelRequest, res: VercelResponse) {
  // POST-only — without this gate, any same-site GET (an <img> tag,
  // a follow-up link, etc.) would clear the user's session. SameSite=Lax
  // narrows the surface but doesn't fully close it for top-level
  // navigations; the method gate does. Mirrors `handleDismissMergeBanner`'s
  // canonical shape.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  await destroySession(req, res);
  res.json({ ok: true });
}

// --- OAuth start + callback -------------------------------------------------

/**
 * Redirect URI must match the *request origin* — not a hardcoded
 * production host — so OAuth state cookies land and can be read back
 * on the same domain. Previously this pinned every deployment to
 * `swutrade.com`, which broke `beta.swutrade.com` sign-in: state
 * cookies were scoped to `beta.*` but Discord redirected back to the
 * apex, where those cookies were invisible.
 *
 * Every host that can initiate sign-in must also be registered in
 * the Discord application's OAuth2 Redirects list.
 */
export function getRedirectUri(req: VercelRequest): string {
  const host = req.headers.host ?? process.env.VERCEL_URL ?? 'localhost:3000';
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isLocal ? 'http' : 'https';
  return `${protocol}://${host}/api/auth/callback`;
}

export async function handleDiscordStart(req: VercelRequest, res: VercelResponse) {
  const redirectUri = getRedirectUri(req);
  const discord = new Discord(
    process.env.DISCORD_CLIENT_ID!,
    process.env.DISCORD_CLIENT_SECRET!,
    redirectUri,
  );
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  // `guilds` scope unlocks Phase 4 — we hit `GET /users/@me/guilds`
  // on callback to populate user_guild_memberships. `identify`
  // remains the baseline for username + avatar.
  const url = discord.createAuthorizationURL(state, codeVerifier, ['identify', 'guilds']);
  const destination = url.toString();

  const cookieOpts = {
    httpOnly: true,
    secure: !redirectUri.startsWith('http://'),
    sameSite: 'lax' as const,
    maxAge: 600,
    path: '/',
  };

  res.setHeader('Set-Cookie', [
    serialize('swu_oauth_state', state, cookieOpts),
    serialize('swu_oauth_verifier', codeVerifier, cookieOpts),
  ]);
  res.setHeader('Cache-Control', 'no-store');

  // HTML interstitial instead of a bare 302. iOS Safari has a known
  // cross-origin-redirect race where a 302 from our origin → a
  // JS-heavy target (discord.com/oauth2/authorize) can strand the
  // user on a permanent white screen that only resolves on refresh.
  // Giving Safari a real HTML document to render first (with
  // cookies already set in the response headers) lets the browser
  // fully commit to our response before navigating cross-origin,
  // avoiding the race. Refresh parity: the <meta refresh> covers
  // no-JS fallback, the <script> fires immediately when JS is on,
  // the <a> is a last-resort manual path.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=${htmlEscape(destination)}">
<title>Signing in…</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0a0e1a; color: #e5e7eb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  p { text-align: center; }
  a { color: #F5A623; }
</style>
</head>
<body>
<p>Redirecting to Discord… <a href="${htmlEscape(destination)}">tap here if nothing happens</a>.</p>
<script>window.location.replace(${JSON.stringify(destination)});</script>
</body>
</html>`);
}

/** Tiny HTML-escape helper for embedding URLs in attributes. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Clear the short-lived OAuth state + verifier cookies.
 *
 * Called from every handleCallback exit path — success AND each
 * 4xx/5xx — so a failed sign-in doesn't leave a verifier cookie
 * sitting next to a fresh state for the full 600s TTL. Pre-fix the
 * cookies persisted on every error branch, opening a small replay
 * window if `state=` ever leaked via referrer / logs / shared
 * screenshots.
 */
function clearOAuthCookies(res: VercelResponse): void {
  const clearOpts = { httpOnly: true, maxAge: 0, path: '/' };
  res.setHeader('Set-Cookie', [
    ...((res.getHeader('Set-Cookie') as string[]) ?? []),
    serialize('swu_oauth_state', '', clearOpts),
    serialize('swu_oauth_verifier', '', clearOpts),
  ]);
}

export async function handleCallback(req: VercelRequest, res: VercelResponse) {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) {
    clearOAuthCookies(res);
    return res.status(400).json({ error: 'Missing code or state' });
  }

  const cookies = parse(req.headers.cookie ?? '');
  const storedState = cookies.swu_oauth_state;
  const codeVerifier = cookies.swu_oauth_verifier;

  if (!storedState || !codeVerifier || state !== storedState) {
    clearOAuthCookies(res);
    return res.status(400).json({ error: 'Invalid state — try signing in again' });
  }

  const redirectUri = getRedirectUri(req);
  const discord = new Discord(
    process.env.DISCORD_CLIENT_ID!,
    process.env.DISCORD_CLIENT_SECRET!,
    redirectUri,
  );

  let tokens;
  try {
    tokens = await discord.validateAuthorizationCode(code, codeVerifier);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('OAuth token exchange failed:', msg, 'redirect_uri:', redirectUri);
    clearOAuthCookies(res);
    return res.status(400).json({ error: 'Failed to exchange code — try signing in again', detail: msg });
  }

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokens.accessToken()}` },
  });
  if (!userRes.ok) {
    clearOAuthCookies(res);
    return res.status(502).json({ error: 'Failed to fetch Discord profile' });
  }
  const discordUser = (await userRes.json()) as {
    id: string;
    username: string;
    avatar: string | null;
    global_name: string | null;
  };

  const displayName = discordUser.global_name ?? discordUser.username;
  const avatarUrl = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
    : null;

  const db = getDb();

  // Ghost-to-real merge: if the caller has an existing session cookie
  // AND that session points at an anonymous user, we'll migrate the
  // ghost's trade_sessions over to the real user row below (after
  // we've resolved or created the real user). Capture the ghost id
  // now — the session cookie gets overwritten on createSession.
  const priorSession = await getSession(req, res);
  const ghostIdToMerge = priorSession?.isAnonymous ? priorSession.userId : null;

  const existing = await db.select().from(users).where(eq(users.discordId, discordUser.id)).limit(1);

  let handle: string;
  if (existing.length > 0) {
    handle = existing[0].handle;
    await db.update(users).set({
      username: displayName,
      avatarUrl,
      updatedAt: new Date(),
    }).where(eq(users.id, existing[0].id));
  } else {
    handle = discordUser.username
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 32) || 'user';

    const handleTaken = await db.select().from(users).where(eq(users.handle, handle)).limit(1);
    if (handleTaken.length > 0) {
      handle = `${handle}-${Math.random().toString(36).slice(2, 6)}`;
    }

    // Public-by-default for new users. Beta feedback: private-by-
    // default made every feature feel walled and required newcomers
    // to hunt through Settings just to appear in community queries.
    // Safer primitive for a discovery-oriented trading app. Existing
    // users' settings are preserved (they're not re-migrated).
    await db.insert(users).values({
      id: discordUser.id,
      discordId: discordUser.id,
      username: displayName,
      handle,
      avatarUrl,
      profileVisibility: 'public',
      wantsPublic: true,
      availablePublic: true,
    });
  }

  // Phase 4: pull the user's guild memberships now that we have a
  // fresh access token. Non-blocking — any failure logs and proceeds
  // to sign-in so OAuth isn't coupled to Discord's guilds endpoint
  // availability.
  await syncGuildMemberships(discordUser.id, tokens.accessToken());

  // Phase 5b ghost migration: if the caller was signed in as a ghost
  // (e.g. they scanned a QR, claimed anonymously, now they're
  // signing in to save the trade), move the ghost's sessions over
  // to this real user row before we swap the cookie. Swallow errors
  // — at worst the ghost's sessions stay under the ghost id until
  // TTL, which degrades gracefully.
  //
  // UX-A5: when the merge moves at least one session, flag the new
  // real-user session cookie so the next /api/auth/me response carries
  // `pendingMergeBanner` — HomeView renders a one-shot reassurance
  // banner ("We carried your trade over"). Silent success made users
  // wonder if their in-progress trade survived the transition.
  let carriedCount = 0;
  if (ghostIdToMerge && ghostIdToMerge !== discordUser.id) {
    try {
      const result = await mergeGhostIntoRealUser(db, ghostIdToMerge, discordUser.id);
      carriedCount = result.migrated;
    } catch (err) {
      console.error('auth callback: ghost merge failed', ghostIdToMerge, err);
    }
  }

  await createSession(req, res, {
    userId: discordUser.id,
    username: displayName,
    handle,
    avatarUrl,
    discordAccessToken: tokens.accessToken(),
    discordAccessTokenExpiresAt: tokens.accessTokenExpiresAt().getTime(),
    pendingMergeBanner: carriedCount > 0 ? { carriedCount } : undefined,
  });

  clearOAuthCookies(res);
  res.redirect(302, '/');
}
