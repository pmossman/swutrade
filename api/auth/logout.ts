import type { VercelRequest, VercelResponse } from '@vercel/node';
import { destroySession } from '../../lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await destroySession(req, res);
  res.json({ ok: true });
}
