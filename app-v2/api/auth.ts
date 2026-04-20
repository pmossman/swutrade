import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Discord, generateState, generateCodeVerifier } from 'arctic';
import { parse, serialize } from 'cookie';
import { eq } from 'drizzle-orm';
import { createSession, destroySession, getSession } from '../../lib/auth.js';
import { getDb } from '../../lib/db.js';
import { users } from '../../lib/schema.js';
import { mergeGhostIntoRealUser } from '../../lib/sessions.js';
import { syncGuildMemberships } from '../../lib/guildSync.js';

/*
 * v2 auth dispatcher. Structurally identical to v1's api/auth.ts —
 * same iron-session helpers, same Discord OAuth flow, same schema.
 * Lives in app-v2/api/ because v2 deploys to its own Vercel project;
 * imports shared lib/ from the repo root (Vercel project must have
 * "Include files outside root directory" enabled — documented in
 * app-v2/README.md).
 *
 * Sub-handlers exported individually so vitest can call them direct.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = (req.query.action as string | undefined) ?? '';
  switch (action) {
    case 'me':
      return handleMe(req, res);
    case 'discord':
      return handleDiscordStart(req, res);
    case 'callback':
      return handleCallback(req, res);
    case 'logout':
      return handleLogout(req, res);
    default:
      return res.status(404).json({ error: 'Unknown /api/auth action' });
  }
}

// --- /api/auth/me -----------------------------------------------------------

export async function handleMe(req: VercelRequest, res: VercelResponse) {
  const session = await getSession(req, res);
  if (!session) {
    return res.json({ user: null, botInstallUrl: null });
  }
  res.json({
    user: {
      id: session.userId,
      username: session.username,
      handle: session.handle,
      avatarUrl: session.avatarUrl,
      isAnonymous: session.isAnonymous ?? false,
    },
    botInstallUrl: buildBotInstallUrl(),
  });
}

// Bot install permissions (see v1's api/auth.ts for the bit breakdown).
const BOT_INSTALL_PERMISSIONS = '360777255952';

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
  await destroySession(req, res);
  res.json({ ok: true });
}

// --- OAuth start + callback -------------------------------------------------

/*
 * Same host-resolution rule as v1: redirect URI must match the request
 * origin so state cookies land and can be read back on the same
 * subdomain. Every host that can initiate sign-in (next.swutrade.com,
 * beta.swutrade.com post-cutover, localhost, preview subdomains) must
 * also be registered in Discord's OAuth2 Redirects list.
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

  // Same iOS Safari cross-origin-redirect workaround as v1: interstitial
  // HTML instead of a bare 302 so Safari commits to the response before
  // navigating cross-origin.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=${htmlEscape(destination)}">
<title>Signing in…</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0A0B0F; color: #F2F2ED; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  p { text-align: center; }
  a { color: #D4A85A; }
</style>
</head>
<body>
<p>Redirecting to Discord… <a href="${htmlEscape(destination)}">tap here if nothing happens</a>.</p>
<script>window.location.replace(${JSON.stringify(destination)});</script>
</body>
</html>`);
}

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
    return res
      .status(400)
      .json({ error: 'Failed to exchange code — try signing in again', detail: msg });
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

  // Capture prior ghost id BEFORE createSession overwrites the cookie.
  const priorSession = await getSession(req, res);
  const ghostIdToMerge = priorSession?.isAnonymous ? priorSession.userId : null;

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.discordId, discordUser.id))
    .limit(1);

  let handle: string;
  if (existing.length > 0) {
    handle = existing[0].handle;
    await db
      .update(users)
      .set({ username: displayName, avatarUrl, updatedAt: new Date() })
      .where(eq(users.id, existing[0].id));
  } else {
    handle =
      discordUser.username
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 32) || 'user';

    const handleTaken = await db
      .select()
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1);
    if (handleTaken.length > 0) {
      handle = `${handle}-${Math.random().toString(36).slice(2, 6)}`;
    }

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

  await syncGuildMemberships(discordUser.id, tokens.accessToken());

  if (ghostIdToMerge && ghostIdToMerge !== discordUser.id) {
    try {
      await mergeGhostIntoRealUser(db, ghostIdToMerge, discordUser.id);
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
  });

  const clearOpts = { httpOnly: true, maxAge: 0, path: '/' };
  res.setHeader('Set-Cookie', [
    ...((res.getHeader('Set-Cookie') as string[]) ?? []),
    serialize('swu_oauth_state', '', clearOpts),
    serialize('swu_oauth_verifier', '', clearOpts),
  ]);

  res.redirect(302, '/');
}
