import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Discord, generateState, generateCodeVerifier } from 'arctic';
import { serialize } from 'cookie';

export function getRedirectUri(): string {
  const host = process.env.VERCEL_URL ?? 'localhost:3000';
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `http://${host}/api/auth/callback`;
  }
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? host;
  return `https://${prodHost}/api/auth/callback`;
}

function getDiscord() {
  return new Discord(
    process.env.DISCORD_CLIENT_ID!,
    process.env.DISCORD_CLIENT_SECRET!,
    getRedirectUri(),
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const discord = getDiscord();
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = discord.createAuthorizationURL(state, codeVerifier, ['identify']);

  const cookieOpts = {
    httpOnly: true,
    secure: !getRedirectUri().startsWith('http://'),
    sameSite: 'lax' as const,
    maxAge: 600,
    path: '/',
  };

  res.setHeader('Set-Cookie', [
    serialize('swu_oauth_state', state, cookieOpts),
    serialize('swu_oauth_verifier', codeVerifier, cookieOpts),
  ]);

  res.redirect(302, url.toString());
}
