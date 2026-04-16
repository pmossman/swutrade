import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Discord } from 'arctic';
import { parse, serialize } from 'cookie';
import { createSession } from '../../lib/auth.js';
import { getDb } from '../../lib/db.js';
import { users } from '../../lib/schema.js';
import { eq } from 'drizzle-orm';
import { getRedirectUri } from './discord.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  const discord = new Discord(
    process.env.DISCORD_CLIENT_ID!,
    process.env.DISCORD_CLIENT_SECRET!,
    getRedirectUri(),
  );

  let tokens;
  try {
    tokens = await discord.validateAuthorizationCode(code, codeVerifier);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('OAuth token exchange failed:', msg, 'redirect_uri:', getRedirectUri());
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
