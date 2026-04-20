import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireSession } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import { users } from '../lib/schema.js';
import {
  cancelSession,
  confirmSession,
  createOrGetActiveSession,
  editSessionSide,
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
    case 'create':
      return handleCreateSession(req, res);
    case 'edit':
      return handleEditSession(req, res);
    case 'confirm':
      return handleConfirmSession(req, res);
    case 'cancel':
      return handleCancelSession(req, res);
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

// --- write endpoints --------------------------------------------------------

const TradeCardSnapshotSchema = z.object({
  productId: z.string().min(1),
  name: z.string(),
  variant: z.string(),
  qty: z.number().int().positive(),
  unitPrice: z.number().nullable(),
});

const CreateBodySchema = z.object({
  counterpartHandle: z.string().min(1).max(64),
  // Creator's starting half. Empty array is fine — the UI also
  // wants to be able to create a blank shared trade and build it
  // together from scratch.
  initialCards: z.array(TradeCardSnapshotSchema).max(200).default([]),
});

const EditBodySchema = z.object({
  cards: z.array(TradeCardSnapshotSchema).max(200),
});

/**
 * Create a new Shared-state trade (session) with a signed-in
 * counterpart, or redirect into an existing active session between
 * the same pair. Response shape:
 *   - 201 + `{ id, created: true }` when a new session was inserted
 *   - 200 + `{ id, created: false }` when redirecting into an existing one
 *
 * Both shapes let the caller `window.location.href = /s/<id>` with
 * the same code path; the `created` flag is just for telemetry /
 * copy tweaks ("you already had a session with @X").
 */
export async function handleCreateSession(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = CreateBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', detail: parsed.error.message });
  }

  const db = getDb();
  // Resolve the counterpart by handle. Must be a real signed-in
  // SWUTrade user — anonymous participants come in a later sliver.
  const handle = parsed.data.counterpartHandle.trim().replace(/^@+/, '');
  const [counterpart] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  if (!counterpart) {
    return res.status(404).json({ error: 'No SWUTrade user with that handle' });
  }
  if (counterpart.id === session.userId) {
    return res.status(400).json({ error: "You can't start a trade with yourself" });
  }

  const result = await createOrGetActiveSession(db, {
    creatorUserId: session.userId,
    counterpartUserId: counterpart.id,
    creatorCards: parsed.data.initialCards,
  });

  res.status(result.created ? 201 : 200).json({
    id: result.id,
    created: result.created,
  });
}

/**
 * Replace the viewer's half of a session. Per-side ownership
 * enforced — a viewer can only edit their own cards, never the
 * counterpart's. Every edit clears confirmations and bumps expiry.
 */
export async function handleEditSession(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id is required' });

  const parsed = EditBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', detail: parsed.error.message });
  }

  const db = getDb();
  const result = await editSessionSide(db, {
    sessionId: id,
    viewerUserId: session.userId,
    cards: parsed.data.cards,
  });
  if (!result.ok) {
    if (result.reason === 'not-found' || result.reason === 'not-participant') {
      return res.status(404).json({ error: 'Not found' });
    }
    if (result.reason === 'terminal') {
      return res.status(409).json({ error: 'Session is no longer active' });
    }
  }
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ session: result.ok ? result.view : null });
}

export async function handleConfirmSession(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id is required' });

  const db = getDb();
  const result = await confirmSession(db, { sessionId: id, viewerUserId: session.userId });
  if (!result.ok) {
    if (result.reason === 'not-found' || result.reason === 'not-participant') {
      return res.status(404).json({ error: 'Not found' });
    }
    if (result.reason === 'terminal') {
      return res.status(409).json({ error: 'Session is no longer active' });
    }
  }
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    session: result.ok ? result.view : null,
    settled: result.ok ? result.settled : false,
  });
}

export async function handleCancelSession(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id is required' });

  const db = getDb();
  const result = await cancelSession(db, { sessionId: id, viewerUserId: session.userId });
  if (!result.ok) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ session: result.view });
}
