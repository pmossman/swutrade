import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Discord, generateState, generateCodeVerifier } from 'arctic';
import { serialize } from 'cookie';

const discord = new Discord(
  process.env.DISCORD_CLIENT_ID!,
  process.env.DISCORD_CLIENT_SECRET!,
  getRedirectUri(),
);

function getRedirectUri(): string {
  if (process.env.VERCEL_ENV === 'development') {
    return 'http://localhost:3000/api/auth/callback';
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/auth/callback`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/api/auth/callback`;
  }
  return 'http://localhost:3000/api/auth/callback';
}

export { discord };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = discord.createAuthorizationURL(state, codeVerifier, ['identify']);

  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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
