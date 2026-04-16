import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSession } from '../../lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
