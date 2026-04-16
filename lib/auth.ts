import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getIronSession, type SessionOptions } from 'iron-session';

export interface SessionData {
  userId: string;
  username: string;
  handle: string;
  avatarUrl: string | null;
}

function getSessionOptions(): SessionOptions {
  return {
    password: process.env.SESSION_SECRET!,
    cookieName: 'swu_session',
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
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
  return {
    userId: session.userId,
    username: session.username,
    handle: session.handle,
    avatarUrl: session.avatarUrl,
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
  await session.save();
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
