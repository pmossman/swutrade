import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireSession } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import {
  getSessionForViewer,
  listActiveSessionsForViewer,
} from '../lib/sessions.js';

/**
 * Phase 5b dispatcher for `/api/sessions/*`. Follows the same
 * action-dispatch pattern as `api/trades.ts` + `api/me.ts` to stay
 * under Vercel's function-count cap (see `project_swutrade_function_ceiling`).
 *
 * Pretty URLs rewritten via `vercel.json`:
 *   GET  /api/sessions/<id>   → ?action=get&id=…
 *   GET  /api/me/sessions     → ?action=list
 *
 * Write actions (create / edit / confirm / cancel) land in a later
 * sliver — this file ships the read-side only.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = (req.query.action as string | undefined) ?? '';
  switch (action) {
    case 'get':
      return handleGetSession(req, res);
    case 'list':
      return handleListSessions(req, res);
    default:
      return res.status(404).json({ error: 'Unknown /api/sessions action' });
  }
}

/**
 * Single session lookup. 404s both when the id doesn't exist AND
 * when the viewer isn't a participant — session ids aren't probeable
 * by non-participants (same policy as trade_proposals detail).
 */
export async function handleGetSession(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  const db = getDb();
  const view = await getSessionForViewer(db, id, session.userId);
  if (!view) {
    return res.status(404).json({ error: 'Not found' });
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ session: view });
}

/**
 * Viewer's active sessions, most-recently-edited first. Used by the
 * Home "Active sessions" module + the future My Trades tab.
 */
export async function handleListSessions(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
  const limit = Number.isFinite(rawLimit) ? rawLimit : 20;

  const db = getDb();
  const sessions = await listActiveSessionsForViewer(db, session.userId, { limit });

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ sessions });
}
