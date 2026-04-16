import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Discord, generateState, generateCodeVerifier } from 'arctic';
import { serialize } from 'cookie';

/**
 * Redirect URI must match the *request origin* — not a hardcoded
 * production host — so OAuth state cookies land and can be read back
 * on the same domain. Previously this pinned every deployment to
 * `swutrade.com`, which broke `beta.swutrade.com` sign-in: state
 * cookies were scoped to `beta.*` but Discord redirected back to the
 * apex, where those cookies were invisible and `storedState` was
 * always undefined.
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const redirectUri = getRedirectUri(req);
  const discord = new Discord(
    process.env.DISCORD_CLIENT_ID!,
    process.env.DISCORD_CLIENT_SECRET!,
    redirectUri,
  );
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  // `guilds` scope unlocks Phase 4 — we hit `GET /users/@me/guilds`
  // on callback to populate user_guild_memberships, which drives
  // per-server enrollment + community source in the card picker.
  // `identify` remains the baseline for username + avatar.
  const url = discord.createAuthorizationURL(state, codeVerifier, ['identify', 'guilds']);

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
  // Prevent bfcache / intermediary caches from serving a stale 302.
  // Mobile Safari was observed rendering a blank Discord page on
  // first tap that only resolved on refresh — scoping this response
  // as uncacheable removes that class of surprise.
  res.setHeader('Cache-Control', 'no-store');

  res.redirect(302, url.toString());
}
