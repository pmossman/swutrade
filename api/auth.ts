import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Discord, generateState, generateCodeVerifier } from 'arctic';
import { parse, serialize } from 'cookie';
import { eq } from 'drizzle-orm';
import { createSession, destroySession, getSession } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import { users } from '../lib/schema.js';
import { syncGuildMemberships } from '../lib/guildSync.js';

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
    case 'me':       return handleMe(req, res);
    case 'discord':  return handleDiscordStart(req, res);
    case 'callback': return handleCallback(req, res);
    case 'logout':   return handleLogout(req, res);
    default:
      return res.status(404).json({ error: 'Unknown /api/auth action' });
  }
}

// --- /api/auth/me -----------------------------------------------------------

export async function handleMe(req: VercelRequest, res: VercelResponse) {
  const session = await getSession(req, res);
  if (!session) {
    return res.json({ user: null });
  }
  res.json({
    user: {
      id: session.userId,
      username: session.username,
      handle: session.handle,
      avatarUrl: session.avatarUrl,
    },
  });
}

// --- /api/auth/logout -------------------------------------------------------

export async function handleLogout(req: VercelRequest, res: VercelResponse) {
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

export async function handleCallback(req: VercelRequest, res: VercelResponse) {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  const cookies = parse(req.headers.cookie ?? '');
  const storedState = cookies.swu_oauth_state;
  const codeVerifier = cookies.swu_oauth_verifier;

  if (!storedState || !codeVerifier || state !== storedState) {
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
    return res.status(400).json({ error: 'Failed to exchange code — try signing in again', detail: msg });
  }

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokens.accessToken()}` },
  });
  if (!userRes.ok) {
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

    await db.insert(users).values({
      id: discordUser.id,
      discordId: discordUser.id,
      username: displayName,
      handle,
      avatarUrl,
    });
  }

  // Phase 4: pull the user's guild memberships now that we have a
  // fresh access token. Non-blocking — any failure logs and proceeds
  // to sign-in so OAuth isn't coupled to Discord's guilds endpoint
  // availability.
  await syncGuildMemberships(discordUser.id, tokens.accessToken());

  await createSession(req, res, {
    userId: discordUser.id,
    username: displayName,
    handle,
    avatarUrl,
  });

  // Clear OAuth cookies.
  const clearOpts = { httpOnly: true, maxAge: 0, path: '/' };
  res.setHeader('Set-Cookie', [
    ...((res.getHeader('Set-Cookie') as string[]) ?? []),
    serialize('swu_oauth_state', '', clearOpts),
    serialize('swu_oauth_verifier', '', clearOpts),
  ]);

  res.redirect(302, '/');
}
