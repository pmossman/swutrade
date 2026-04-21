import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createSession as createAuthSession, getSession, requireSession } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import type { DiscordBotClient } from '../lib/discordBot.js';
import { users } from '../lib/schema.js';
import {
  cancelSession,
  claimOpenSlot,
  confirmSession,
  createGhostUser,
  createOpenSession,
  createOrGetActiveSession,
  editSessionSide,
  getSessionForViewer,
  getSessionPreview,
  inviteHandleToSession,
  listActiveSessionsForViewer,
  unconfirmSession,
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
    case 'unconfirm':
      return handleUnconfirmSession(req, res);
    case 'cancel':
      return handleCancelSession(req, res);
    case 'create-open':
      return handleCreateOpenSession(req, res);
    case 'claim':
      return handleClaimSession(req, res);
    case 'invite-handle':
      return handleInviteHandle(req, res);
    default:
      return res.status(404).json({ error: 'Unknown /api/sessions action' });
  }
}

/**
 * Single session lookup. Response shape varies by viewer's
 * relationship to the session:
 *
 *   - Participant viewer → `{ session: SessionView }` with the full
 *     viewer-centric render.
 *   - Non-participant + session has open slot B → `{ preview:
 *     SessionPreview }` so the UI can show a "Join this trade"
 *     prompt with the creator's identity.
 *   - Anything else (terminal, pair filled, unknown id) → 404.
 *
 * No auth required — an anonymous visitor hitting a QR-coded URL
 * gets the preview without needing a session cookie first. They'll
 * create a ghost session cookie when they actually claim via
 * POST /api/sessions/:id/claim.
 */
export async function handleGetSession(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  const db = getDb();

  // Viewer first — if they're a participant, give them the full
  // session payload. Anonymous users (no cookie) skip this branch.
  const session = await getSession(req, res);
  if (session) {
    const view = await getSessionForViewer(db, id, session.userId);
    if (view) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ session: view });
    }
  }

  // Not a participant (or not signed in) — check if this is an open
  // invitation we can preview. Anyone with the URL can preview; the
  // preview is intentionally limited (creator identity + card
  // count, no card list).
  const preview = await getSessionPreview(db, id);
  if (preview) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ preview });
  }

  return res.status(404).json({ error: 'Not found' });
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

/**
 * Remove the viewer from a session's confirmation set. Mirrors
 * handleConfirmSession's shape (same 404 / 409 semantics); terminal
 * sessions refuse with 409 since you can't undo a handshake once
 * both sides have committed.
 */
export async function handleUnconfirmSession(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id is required' });

  const db = getDb();
  const result = await unconfirmSession(db, { sessionId: id, viewerUserId: session.userId });
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

/**
 * Create an "open-slot" shared trade — slot A is the creator, slot B
 * stays null until someone claims it via QR / shared link. Accepts
 * both signed-in and anonymous creators:
 *   - Signed in: session.userId is the creator, no ghost minted.
 *   - Anonymous: mints a ghost user (same pattern as the claim
 *     handler), sets the iron-session cookie to that ghost, and the
 *     ghost becomes the creator.
 *
 * Anonymous creation is what enables the "two strangers at the LGS
 * with no SWUTrade account" flow — the first person hits the Share
 * button, a ghost is minted, they see their QR, the second person
 * scans → second ghost minted → both trade as guests. Either can
 * sign in later to save via the OAuth-callback merge.
 */
const CreateOpenBodySchema = z.object({
  initialCards: z.array(TradeCardSnapshotSchema).max(200).default([]),
  counterpartInitialCards: z.array(TradeCardSnapshotSchema).max(200).default([]),
});

export async function handleCreateOpenSession(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = CreateOpenBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', detail: parsed.error.message });
  }

  const db = getDb();

  // Resolve creator identity — existing session OR mint a ghost.
  // Same pattern as handleClaimSession; the ghost case is what
  // makes anonymous QR-first flows possible.
  let creatorUserId: string;
  let mintedGhost: { id: string; handle: string; username: string } | null = null;
  const existing = await getSession(req, res);
  if (existing) {
    creatorUserId = existing.userId;
  } else {
    const ghost = await createGhostUser(db);
    await createAuthSession(req, res, {
      userId: ghost.id,
      username: ghost.username,
      handle: ghost.handle,
      avatarUrl: null,
      isAnonymous: true,
    });
    mintedGhost = ghost;
    creatorUserId = ghost.id;
  }

  const { id } = await createOpenSession(db, {
    creatorUserId,
    creatorCards: parsed.data.initialCards,
    counterpartInitialCards: parsed.data.counterpartInitialCards,
  });

  return res.status(201).json({ id, ghost: mintedGhost });
}

/**
 * Claim the open slot B of an existing session. Works for both
 * signed-in and anonymous visitors:
 *   - Signed-in: session cookie identifies the claimer; they
 *     become slot B as a real user.
 *   - Anonymous: server mints a fresh ghost user, sets the
 *     iron-session cookie to that ghost id, and the ghost becomes
 *     slot B. The browser is now "signed in as guest" for the
 *     duration of the ghost's TTL — they can edit the session and
 *     the cookie will carry them across reloads. Future sign-in via
 *     Discord merges the ghost into the real account.
 *
 * Idempotent: if the claimer is already a participant, returns the
 * current view. Race-safe: two concurrent anonymous claims will
 * cause one of them to hit `conflict`.
 */
export async function handleClaimSession(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id is required' });

  const db = getDb();

  // Resolve the viewer — existing cookie OR mint a ghost.
  let viewerId: string;
  let mintedGhost: { id: string; handle: string; username: string } | null = null;
  const existing = await getSession(req, res);
  if (existing) {
    viewerId = existing.userId;
  } else {
    const ghost = await createGhostUser(db);
    await createAuthSession(req, res, {
      userId: ghost.id,
      username: ghost.username,
      handle: ghost.handle,
      avatarUrl: null,
      isAnonymous: true,
    });
    mintedGhost = ghost;
    viewerId = ghost.id;
  }

  const result = await claimOpenSlot(db, { sessionId: id, viewerUserId: viewerId });
  if (!result.ok) {
    // Map library reasons to HTTP. 'self' = creator trying to claim
    // their own invite; 'conflict' = slot already filled by someone
    // else; 'terminal' = session is no longer active; 'not-found'
    // = bad id.
    if (result.reason === 'not-found') return res.status(404).json({ error: 'Not found' });
    if (result.reason === 'self') return res.status(400).json({ error: "You can't claim your own invitation" });
    if (result.reason === 'terminal') return res.status(409).json({ error: 'Session is no longer active' });
    if (result.reason === 'conflict') return res.status(409).json({ error: 'Someone else already joined this session' });
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(result.ok && result.claimed ? 201 : 200).json({
    session: result.ok ? result.view : null,
    ghost: mintedGhost,
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

// --- invite-by-handle -------------------------------------------------------

const InviteHandleBodySchema = z.object({
  handle: z.string().min(1).max(64),
});

/**
 * Alternative to the QR / share-link affordance: the creator picks a
 * known SWUTrade handle and the server delivers the session URL to
 * that user's Discord DMs directly. No pre-claim — the recipient
 * still has to click the link and go through the normal join flow.
 *
 * Gated on sign-in: ghost (anonymous) creators can't originate DMs
 * because they have no Discord presence. Their existing QR / share
 * link path still works — this endpoint is a convenience for users
 * who know the recipient's handle.
 *
 * `deps.bot` is injectable so integration tests can pass a fake
 * DiscordBotClient and assert on `sendDirectMessage` calls without
 * hitting Discord.
 */
export async function handleInviteHandle(
  req: VercelRequest,
  res: VercelResponse,
  deps: { bot?: DiscordBotClient } = {},
) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id is required' });

  // Ghost creators can't invite by handle — they have no Discord
  // presence to originate from, and ghost-to-ghost DMs don't exist.
  // Fall back to the QR / share-link path the OpenSlotInvite already
  // renders for them.
  if (session.isAnonymous) {
    return res.status(403).json({
      error: 'Sign in to invite specific people. Anyone with your QR / link can still join as a guest.',
    });
  }

  const parsed = InviteHandleBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', detail: parsed.error.message });
  }

  // Build the outbound link off the same host the request came in on
  // so preview deploys stay self-contained. `bot.ts` uses the same
  // pattern — the header is authoritative in production because the
  // platform overwrites it; env-var fallback covers local scripts.
  const appBaseUrl = req.headers.host
    ? `https://${req.headers.host}`
    : process.env.SWUTRADE_PUBLIC_URL ?? 'https://beta.swutrade.com';

  const db = getDb();
  const result = await inviteHandleToSession(db, {
    sessionId: id,
    viewerUserId: session.userId,
    targetHandle: parsed.data.handle,
    bot: deps.bot,
    appBaseUrl,
  });

  if (!result.ok) {
    switch (result.reason) {
      case 'not-found':
        return res.status(404).json({ error: 'Not found' });
      case 'not-creator':
        return res.status(403).json({ error: 'Only the session creator can invite' });
      case 'not-open':
        return res.status(409).json({ error: 'This session is no longer open for invites' });
      case 'self-invite':
        return res.status(400).json({ error: "You can't invite yourself" });
      case 'no-such-handle':
        return res.status(404).json({ error: 'No SWUTrade user with that handle' });
      case 'dm-failed':
        return res.status(502).json({ error: 'Could not send the Discord DM. They may have DMs disabled.' });
    }
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ invited: result.invited });
}
