import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq, and, or, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { requireSession } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import { trades, tradeProposals, users, type TradeCardSnapshot } from '../lib/schema.js';
import { createDiscordBotClient, type DiscordBotClient } from '../lib/discordBot.js';
import {
  buildProposalMessage,
  buildCounterProposalMessage,
  buildCounteredProposalMessage,
  buildResolvedProposalMessage,
} from '../lib/proposalMessages.js';

/**
 * Single dispatcher for every `/api/trades/*` endpoint.
 *
 * History: the default (no action) is the original Phase 2 "save my
 * trade" endpoint — GET lists the signed-in user's saved trades,
 * POST saves a new one. Kept under the default route so existing
 * clients don't break. Phase 4c adds inter-user proposals under
 * named actions.
 *
 * Vercel Hobby plan caps at 12 serverless functions; `trades.ts` +
 * the /api/me dispatcher + auth + bot + sync share the budget. See
 * `project_swutrade_function_ceiling` memory for context.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = (req.query.action as string | undefined) ?? '';

  switch (action) {
    case '':           return handleSavedTrades(req, res);
    case 'propose':    return handlePropose(req, res);
    case 'counter':    return handleCounter(req, res);
    case 'get':        return handleGetProposal(req, res);
    case 'proposals':  return handleProposalsList(req, res);
    case 'cancel':     return handleCancel(req, res);
    default:
      return res.status(404).json({ error: 'Unknown /api/trades action' });
  }
}

// --- saved trades (default action — original /api/trades behavior) ----------

interface SaveTradeBody {
  yourCards: TradeCardSnapshot[];
  theirCards: TradeCardSnapshot[];
  percentage: number;
  priceMode: string;
  totalYours: number;
  totalTheirs: number;
}

export async function handleSavedTrades(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  if (req.method === 'GET') {
    const rows = await db.select().from(trades)
      .where(eq(trades.userId, session.userId))
      .orderBy(desc(trades.createdAt))
      .limit(50);
    return res.json(rows.map(r => ({
      id: r.id,
      yourCards: r.yourCards,
      theirCards: r.theirCards,
      percentage: r.percentage,
      priceMode: r.priceMode,
      totalYours: Number(r.totalYours),
      totalTheirs: Number(r.totalTheirs),
      createdAt: r.createdAt.toISOString(),
    })));
  }

  if (req.method === 'POST') {
    const body = req.body as SaveTradeBody;
    if (!body.yourCards?.length && !body.theirCards?.length) {
      return res.status(400).json({ error: 'Trade must have at least one card' });
    }

    const id = crypto.randomUUID();
    await db.insert(trades).values({
      id,
      userId: session.userId,
      yourCards: body.yourCards,
      theirCards: body.theirCards,
      percentage: body.percentage,
      priceMode: body.priceMode,
      totalYours: body.totalYours.toString(),
      totalTheirs: body.totalTheirs.toString(),
    });

    return res.status(201).json({ id });
  }

  res.status(405).json({ error: 'Method not allowed' });
}

// --- propose (Phase 4c slice 2) ---------------------------------------------

const TradeCardSnapshotSchema = z.object({
  productId: z.string().min(1),
  name: z.string(),
  variant: z.string(),
  qty: z.number().int().positive(),
  unitPrice: z.number().nullable(),
});

const ProposeBodySchema = z.object({
  recipientHandle: z.string().min(1).max(64),
  offeringCards: z.array(TradeCardSnapshotSchema),
  receivingCards: z.array(TradeCardSnapshotSchema),
  message: z.string().max(500).optional(),
}).refine(
  data => data.offeringCards.length > 0 || data.receivingCards.length > 0,
  { message: 'Proposal must include at least one card' },
);

/**
 * Create a pending trade proposal from the signed-in user to
 * `recipientHandle`. Called by the ProposeView composer after the
 * user confirms their selection.
 *
 * Card arrays are frozen snapshots — see `trade_proposals` schema
 * comment for why (prices drift; lists mutate between send + response).
 *
 * Flow:
 *   1. Validate payload + recipient existence/visibility
 *   2. Insert the proposal row (delivery_status=pending)
 *   3. Bot DMs the recipient with the embed + Accept/Decline buttons
 *   4. On DM success, update the row with channel/message ids +
 *      delivery_status=delivered. On DM failure, set delivery_status
 *      =failed but KEEP the row — the proposer's composer UI can
 *      fall back to "share this link manually" without us losing
 *      the trade on a transient Discord outage.
 *
 * `bot` is injectable so integration tests don't call real Discord.
 */
export async function handlePropose(
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

  const parsed = ProposeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() });
  }
  const { recipientHandle, offeringCards, receivingCards, message } = parsed.data;

  const db = getDb();

  const [recipient] = await db
    .select({
      id: users.id,
      discordId: users.discordId,
      handle: users.handle,
      profileVisibility: users.profileVisibility,
    })
    .from(users)
    .where(eq(users.handle, recipientHandle))
    .limit(1);
  if (!recipient) {
    return res.status(404).json({ error: 'Recipient not found' });
  }
  if (recipient.id === session.userId) {
    return res.status(400).json({ error: 'Cannot propose a trade to yourself' });
  }
  if (recipient.profileVisibility === 'private') {
    // Private profiles don't receive proposals — if they want
    // trades, they turn visibility back up. Same message as "not
    // found" to avoid confirming existence of a private account.
    return res.status(404).json({ error: 'Recipient not found' });
  }

  const [proposer] = await db
    .select({ handle: users.handle, username: users.username })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (!proposer) {
    // Session is valid but user row vanished — data inconsistency,
    // shouldn't happen in practice but fail loud if it does.
    return res.status(500).json({ error: 'Proposer user record not found' });
  }

  const id = crypto.randomUUID();
  await db.insert(tradeProposals).values({
    id,
    proposerUserId: session.userId,
    recipientUserId: recipient.id,
    status: 'pending',
    offeringCards,
    receivingCards,
    message: message ?? null,
    deliveryStatus: 'pending',
  });

  // Get proposer's discordId too — thread flow adds both users as
  // members, not just the recipient.
  const [proposerFull] = await db
    .select({ discordId: users.discordId })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  const bot = deps.bot ?? createDiscordBotClient();
  const payload = buildProposalMessage({
    tradeId: id,
    proposerHandle: proposer.handle,
    proposerUsername: proposer.username,
    offeringCards,
    receivingCards,
    message,
  });

  // Deliver the proposal. Errors never 5xx — the row is already
  // persisted and the proposer should still get a 201. The client
  // reads delivery_status to decide whether to show a "saved but
  // couldn't deliver" fallback.
  //
  // Delivery path resolves in priority order:
  //   1. Thread flow (preferred) — private thread in the configured
  //      TRADES_CHANNEL_ID, both users added. They can chat directly.
  //   2. DM fallback — per-user DM (legacy behavior). Used when
  //      thread creation fails (user not in guild, bot perms missing,
  //      or env unset).
  let deliveryStatus: 'delivered' | 'failed' = 'failed';
  let channelId: string | null = null;
  let messageId: string | null = null;
  let threadId: string | null = null;
  let threadParentChannelId: string | null = null;

  const tradesChannelId = process.env.TRADES_CHANNEL_ID;
  if (tradesChannelId && proposerFull?.discordId) {
    try {
      const thread = await bot.createPrivateThread(tradesChannelId, {
        name: threadName(proposer.handle, recipient.handle, id),
      });
      // Add both traders. Do these in parallel — sequential adds add
      // a noticeable delay to the proposer's "Send" response.
      await Promise.all([
        bot.addThreadMember(thread.id, proposerFull.discordId),
        bot.addThreadMember(thread.id, recipient.discordId),
      ]);
      const posted = await bot.postChannelMessage(thread.id, payload);
      threadId = thread.id;
      threadParentChannelId = thread.parent_id ?? tradesChannelId;
      channelId = thread.id;
      messageId = posted.id;
      deliveryStatus = 'delivered';
    } catch (err) {
      console.error('handlePropose: thread flow failed, falling back to DM', err);
    }
  }

  if (deliveryStatus === 'failed') {
    try {
      const posted = await bot.sendDirectMessage(recipient.discordId, payload);
      channelId = posted.channel_id;
      messageId = posted.id;
      deliveryStatus = 'delivered';
    } catch (err) {
      console.error('handlePropose: DM send failed', err);
    }
  }

  await db.update(tradeProposals)
    .set({
      deliveryStatus,
      discordDmChannelId: channelId,
      discordDmMessageId: messageId,
      discordThreadId: threadId,
      discordThreadParentChannelId: threadParentChannelId,
      updatedAt: new Date(),
    })
    .where(eq(tradeProposals.id, id));

  return res.status(201).json({ id, deliveryStatus });
}

/**
 * Thread names live in Discord's sidebar alongside other channels so
 * a human-readable form beats the trade UUID. Format:
 * `trade-<proposer>-<recipient>-<short_id>` — the short id is the
 * first 4 chars of the UUID, enough to disambiguate when the same
 * two users have multiple open threads.
 */
function threadName(proposerHandle: string, recipientHandle: string, tradeId: string): string {
  const shortId = tradeId.slice(0, 4);
  // Discord thread names cap at 100 chars. Truncate defensively —
  // real handles are 32 chars max per our schema, so this is usually
  // safe but handles could grow.
  const raw = `trade-${proposerHandle}-${recipientHandle}-${shortId}`;
  return raw.slice(0, 100);
}

// --- get (Phase 4c slice 4 — for CounterBar to seed its composer) -----------

/**
 * Fetch a single proposal by id. Auth: viewer must be either the
 * proposer or the recipient. Anyone else gets 404 (no existence
 * leak).
 *
 * Returns shape mirrors the DB row but strips Discord-transport
 * fields the client doesn't need.
 */
export async function handleGetProposal(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = (req.query.id as string | undefined) ?? '';
  if (!id) return res.status(400).json({ error: 'Missing id' });

  const db = getDb();
  const [row] = await db
    .select()
    .from(tradeProposals)
    .where(eq(tradeProposals.id, id))
    .limit(1);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.proposerUserId !== session.userId && row.recipientUserId !== session.userId) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Look up proposer + recipient handles so the client doesn't need
  // a second round-trip to render "proposing to @X" context.
  const [proposer] = await db
    .select({ handle: users.handle, username: users.username, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, row.proposerUserId))
    .limit(1);
  const [recipient] = await db
    .select({ handle: users.handle, username: users.username, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, row.recipientUserId))
    .limit(1);

  // Chain context — minimal stubs so the detail view can render
  // "counter to …" / "countered by …" links without a second fetch.
  // Full chain walking is a trade-history concern, not a detail-view
  // concern.
  let counterOfStub: { id: string; status: string } | null = null;
  if (row.counterOfId) {
    const [parent] = await db
      .select({ id: tradeProposals.id, status: tradeProposals.status })
      .from(tradeProposals)
      .where(eq(tradeProposals.id, row.counterOfId))
      .limit(1);
    counterOfStub = parent ?? null;
  }

  let counteredByStub: { id: string; status: string } | null = null;
  const [child] = await db
    .select({ id: tradeProposals.id, status: tradeProposals.status })
    .from(tradeProposals)
    .where(eq(tradeProposals.counterOfId, row.id))
    .limit(1);
  if (child) counteredByStub = child;

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    id: row.id,
    status: row.status,
    counterOfId: row.counterOfId,
    counterOfStub,
    counteredByStub,
    offeringCards: row.offeringCards,
    receivingCards: row.receivingCards,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
    proposer: proposer ?? null,
    recipient: recipient ?? null,
    viewerIsProposer: row.proposerUserId === session.userId,
    viewerIsRecipient: row.recipientUserId === session.userId,
  });
}

// --- proposals list (slice 5 — for /?trades=1 history view) -----------------

/**
 * Lists proposals involving the signed-in user (proposer OR
 * recipient). Ordered by updated_at desc so active chains surface
 * first. Each row carries just what the history UI needs — the
 * detail view fetches the full row via `handleGetProposal` when
 * the user clicks through.
 *
 * No pagination for MVP. Limited to 100 to keep payloads bounded;
 * once a real user has that many proposals we'll add cursors.
 */
export async function handleProposalsList(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();

  const rows = await db
    .select()
    .from(tradeProposals)
    .where(or(
      eq(tradeProposals.proposerUserId, session.userId),
      eq(tradeProposals.recipientUserId, session.userId),
    ))
    .orderBy(desc(tradeProposals.updatedAt))
    .limit(100);

  // Fetch counterpart users in one query — for each row the
  // counterpart is whichever party isn't the viewer.
  const counterpartIds = Array.from(new Set(
    rows.map(r => r.proposerUserId === session.userId ? r.recipientUserId : r.proposerUserId),
  ));
  const counterpartsById = new Map<string, { handle: string; username: string; avatarUrl: string | null }>();
  if (counterpartIds.length > 0) {
    const userRows = await db
      .select({
        id: users.id,
        handle: users.handle,
        username: users.username,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(inArray(users.id, counterpartIds));
    for (const u of userRows) {
      counterpartsById.set(u.id, { handle: u.handle, username: u.username, avatarUrl: u.avatarUrl });
    }
  }

  const proposals = rows.map(r => {
    const direction: 'sent' | 'received' = r.proposerUserId === session.userId ? 'sent' : 'received';
    const counterpartId = direction === 'sent' ? r.recipientUserId : r.proposerUserId;
    return {
      id: r.id,
      direction,
      status: r.status,
      counterOfId: r.counterOfId,
      offeringCount: r.offeringCards.reduce((n, c) => n + c.qty, 0),
      receivingCount: r.receivingCards.reduce((n, c) => n + c.qty, 0),
      hasMessage: !!r.message,
      counterpart: counterpartsById.get(counterpartId) ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      respondedAt: r.respondedAt ? r.respondedAt.toISOString() : null,
    };
  });

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ proposals });
}

// --- cancel (slice 5 — proposer retracts a pending proposal) ---------------

const CancelBodySchema = z.object({
  id: z.string().min(1),
});

/**
 * Proposer-only. Transitions a `pending` proposal to `cancelled`
 * and edits the recipient's DM to strip buttons + show a cancelled
 * banner. Idempotent w.r.t. already-cancelled (returns 200 no-op).
 * Race-guarded: if the recipient accepted/declined/countered
 * between the read and write, returns 409.
 *
 * DM edit is best-effort (same pattern as the counter handler).
 */
export async function handleCancel(
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

  const parsed = CancelBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  const { id } = parsed.data;

  const db = getDb();
  const [row] = await db
    .select()
    .from(tradeProposals)
    .where(eq(tradeProposals.id, id))
    .limit(1);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.proposerUserId !== session.userId) {
    return res.status(403).json({ error: 'Only the proposer can cancel' });
  }
  if (row.status === 'cancelled') {
    // Idempotent — already cancelled.
    return res.json({ id, status: 'cancelled' });
  }
  if (row.status !== 'pending') {
    return res.status(409).json({
      error: 'already-resolved',
      detail: `This proposal is ${row.status} and can no longer be cancelled.`,
    });
  }

  // Optimistic concurrency: transition only if still pending.
  const updated = await db
    .update(tradeProposals)
    .set({ status: 'cancelled', respondedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(tradeProposals.id, id),
      eq(tradeProposals.status, 'pending'),
    ))
    .returning({ id: tradeProposals.id });

  if (updated.length === 0) {
    return res.status(409).json({
      error: 'already-resolved',
      detail: 'The proposal was resolved before your cancel landed.',
    });
  }

  // Edit recipient's DM — best effort.
  if (row.discordDmChannelId && row.discordDmMessageId) {
    try {
      const [proposer] = await db
        .select({ handle: users.handle, username: users.username })
        .from(users)
        .where(eq(users.id, row.proposerUserId))
        .limit(1);
      if (proposer) {
        const bot = deps.bot ?? createDiscordBotClient();
        const patched = buildResolvedProposalMessage(
          {
            tradeId: row.id,
            proposerHandle: proposer.handle,
            proposerUsername: proposer.username,
            offeringCards: row.offeringCards,
            receivingCards: row.receivingCards,
            message: row.message,
          },
          'cancelled',
          proposer.handle,
        );
        await bot.editChannelMessage(row.discordDmChannelId, row.discordDmMessageId, patched);
      }
    } catch (err) {
      console.error('handleCancel: DM edit failed', err);
    }
  }

  return res.json({ id, status: 'cancelled' });
}

// --- counter (Phase 4c slice 4) ---------------------------------------------

const CounterBodySchema = z.object({
  counterOfId: z.string().min(1),
  offeringCards: z.array(TradeCardSnapshotSchema),
  receivingCards: z.array(TradeCardSnapshotSchema),
  message: z.string().max(500).optional(),
}).refine(
  data => data.offeringCards.length > 0 || data.receivingCards.length > 0,
  { message: 'Counter must include at least one card' },
);

/**
 * Submit a counter to an existing pending proposal. Creates a new
 * trade_proposals row linked via `counter_of_id` to the original,
 * transitions the original to `'countered'`, edits the original's
 * DM in place, and DMs the original proposer with the new counter.
 *
 * Authorization: signed-in user must be the recipient of the
 * original proposal. Non-recipients get 403 (distinct from 404
 * — the trade exists, they just can't act on it).
 *
 * Race guard: the original status must be `'pending'` at commit
 * time. If it's already resolved (proposer accepted/declined/
 * cancelled, or another counter slipped through), we return 409
 * with `error='already-resolved'` and do NOT leave a counter row
 * dangling.
 *
 * DM side-effects are best-effort — the counter row is created
 * and the original is transitioned even if the Discord calls fail.
 * The proposer will still see the counter in the web app once the
 * detail/history views ship.
 */
export async function handleCounter(
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

  const parsed = CounterBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() });
  }
  const { counterOfId, offeringCards, receivingCards, message } = parsed.data;

  const db = getDb();

  // Load original — must exist, viewer must be the recipient,
  // status must be pending.
  const [original] = await db
    .select()
    .from(tradeProposals)
    .where(eq(tradeProposals.id, counterOfId))
    .limit(1);
  if (!original) return res.status(404).json({ error: 'Original not found' });
  if (original.recipientUserId !== session.userId) {
    return res.status(403).json({ error: 'Only the recipient can counter this proposal' });
  }
  if (original.status !== 'pending') {
    return res.status(409).json({
      error: 'already-resolved',
      detail: `This proposal is ${original.status} and can no longer be countered.`,
    });
  }

  const [originalProposer] = await db
    .select({
      id: users.id,
      discordId: users.discordId,
      handle: users.handle,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, original.proposerUserId))
    .limit(1);
  const [originalRecipient] = await db
    .select({
      id: users.id,
      discordId: users.discordId,
      handle: users.handle,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, original.recipientUserId))
    .limit(1);
  if (!originalProposer || !originalRecipient) {
    return res.status(500).json({ error: 'User records not found' });
  }

  const counterId = crypto.randomUUID();

  // Insert the counter row first. If the next step (transitioning
  // the original) fails under the optimistic concurrency check,
  // we delete this row so nothing orphans.
  await db.insert(tradeProposals).values({
    id: counterId,
    proposerUserId: session.userId,   // original's recipient becomes the new proposer
    recipientUserId: original.proposerUserId,
    counterOfId: original.id,
    status: 'pending',
    offeringCards,
    receivingCards,
    message: message ?? null,
    deliveryStatus: 'pending',
  });

  // Optimistic concurrency: transition only if original is STILL
  // pending. If another concurrent action beat us (accept, decline,
  // or another counter), we roll back.
  const updated = await db
    .update(tradeProposals)
    .set({ status: 'countered', respondedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(tradeProposals.id, original.id),
      eq(tradeProposals.status, 'pending'),
    ))
    .returning({ id: tradeProposals.id });

  if (updated.length === 0) {
    // Race lost — someone resolved the original between our read
    // and write. Clean up the counter we inserted and report back.
    // Log cleanup failures so orphan counters don't pile up silently
    // (the row has no user-reachable side effects, but the id stays
    // allocated and will show up in any auditing query).
    await db
      .delete(tradeProposals)
      .where(eq(tradeProposals.id, counterId))
      .catch((err) => {
        console.error('handleCounter: orphan cleanup failed', { counterId, err });
      });
    return res.status(409).json({
      error: 'already-resolved',
      detail: 'The original proposal was resolved before your counter landed.',
    });
  }

  // DM side-effects (best effort, never 5xx this call)
  const bot = deps.bot ?? createDiscordBotClient();

  // 1) Edit the original's DM to strip buttons + show countered
  //    status. Only if we actually have a message id to edit.
  if (original.discordDmChannelId && original.discordDmMessageId) {
    try {
      const patched = buildCounteredProposalMessage(
        {
          tradeId: original.id,
          proposerHandle: originalProposer.handle,
          proposerUsername: originalProposer.username,
          offeringCards: original.offeringCards,
          receivingCards: original.receivingCards,
          message: original.message,
        },
        originalRecipient.handle,
      );
      await bot.editChannelMessage(original.discordDmChannelId, original.discordDmMessageId, patched);
    } catch (err) {
      console.error('handleCounter: edit original DM failed', err);
    }
  }

  // 2) Send the new counter DM to the original proposer.
  let counterDeliveryStatus: 'delivered' | 'failed' = 'failed';
  let counterChannelId: string | null = null;
  let counterMessageId: string | null = null;
  try {
    const counterDm = buildCounterProposalMessage({
      tradeId: counterId,
      proposerHandle: originalRecipient.handle, // counter's proposer = original's recipient
      proposerUsername: originalRecipient.username,
      offeringCards,
      receivingCards,
      message,
      counteredTradeId: original.id,
    });
    const posted = await bot.sendDirectMessage(originalProposer.discordId, counterDm);
    counterChannelId = posted.channel_id;
    counterMessageId = posted.id;
    counterDeliveryStatus = 'delivered';
  } catch (err) {
    console.error('handleCounter: counter DM send failed', err);
  }

  await db.update(tradeProposals)
    .set({
      deliveryStatus: counterDeliveryStatus,
      discordDmChannelId: counterChannelId,
      discordDmMessageId: counterMessageId,
      updatedAt: new Date(),
    })
    .where(eq(tradeProposals.id, counterId));

  return res.status(201).json({ id: counterId, deliveryStatus: counterDeliveryStatus });
}
