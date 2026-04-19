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
import { deliveryForPair, type CommunicationPref } from '../lib/threadConsent.js';
import { resolvePref } from '../lib/prefsResolver.js';
import { reportError } from '../lib/errorReporter.js';
import { recordEvent, listEvents } from '../lib/proposalEvents.js';

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
    case 'edit':       return handleEdit(req, res);
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
    .select({
      handle: users.handle,
      username: users.username,
    })
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
  await recordEvent(db, {
    proposalId: id,
    actorUserId: session.userId,
    type: 'created',
  });

  // Get proposer's discordId too — thread flow adds both users as
  // members, not just the recipient.
  const [proposerFull] = await db
    .select({ discordId: users.discordId })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  const bot = deps.bot ?? createDiscordBotClient();

  // Resolve each party's EFFECTIVE communicationPref for this specific
  // pair through the cascade (peer override on the other party → self
  // default → registry default). The decision matrix only sees
  // pre-resolved values so `threadConsent.ts` stays pure. A peer
  // override on either side can flip the delivery outcome.
  const [proposerEffective, recipientEffective] = await Promise.all([
    resolvePref({
      key: 'communicationPref',
      viewerUserId: session.userId,
      peerUserId: recipient.id,
    }),
    resolvePref({
      key: 'communicationPref',
      viewerUserId: recipient.id,
      peerUserId: session.userId,
    }),
  ]);
  const delivery = deliveryForPair(
    proposerEffective as CommunicationPref,
    recipientEffective as CommunicationPref,
  );

  // Deliver the proposal. Errors never 5xx — the row is already
  // persisted and the proposer should still get a 201. The client
  // reads delivery_status to decide whether to show a "saved but
  // couldn't deliver" fallback.
  let deliveryStatus: 'delivered' | 'failed' = 'failed';
  let channelId: string | null = null;
  let messageId: string | null = null;
  let threadId: string | null = null;
  let threadParentChannelId: string | null = null;

  const tradesChannelId = process.env.TRADES_CHANNEL_ID;
  const canCreateThread = !!tradesChannelId && !!proposerFull?.discordId;

  if (delivery === 'thread-immediately' && canCreateThread) {
    let createdThreadId: string | null = null;
    try {
      const payload = buildProposalMessage({
        tradeId: id,
        proposerUserId: session.userId,
        proposerHandle: proposer.handle,
        proposerUsername: proposer.username,
        offeringCards,
        receivingCards,
        message,
      });
      const thread = await bot.createPrivateThread(tradesChannelId!, {
        name: threadName(proposer.handle, recipient.handle, id),
      });
      createdThreadId = thread.id;
      // Add both traders. Do these in parallel — sequential adds add
      // a noticeable delay to the proposer's "Send" response.
      // Promise.all fails-fast on the first rejection, which is what
      // we want: if either add fails (e.g., recipient isn't a real
      // Discord user, like the dev-seed fakes), we bail and fall
      // through to DM. The catch below cleans up the partial thread.
      await Promise.all([
        bot.addThreadMember(thread.id, proposerFull!.discordId),
        bot.addThreadMember(thread.id, recipient.discordId),
      ]);
      const posted = await bot.postChannelMessage(thread.id, payload);
      threadId = thread.id;
      threadParentChannelId = thread.parent_id ?? tradesChannelId!;
      channelId = thread.id;
      messageId = posted.id;
      deliveryStatus = 'delivered';
    } catch (err) {
      console.error('handlePropose: thread flow failed, falling back to DM', err);
      await reportError({
        source: 'trades.propose.thread-create',
        tags: { tradeId: id, proposerId: session.userId, recipientId: recipient.id },
      }, err);
      // Clean up the orphan thread so the parent channel doesn't
      // accumulate empty "proposer only" threads. Best-effort —
      // if the delete itself fails, we've already logged the
      // original thread-flow error so debugging the chain is
      // traceable; swallow this cleanup error to avoid masking it.
      if (createdThreadId) {
        bot.deleteChannel(createdThreadId).catch(cleanupErr => {
          console.error('handlePropose: orphan thread cleanup failed', cleanupErr);
        });
      }
    }
  }

  // DM fallback: either the delivery matrix chose a DM path, or the
  // thread path failed above. In both cases we DM the recipient; the
  // request-thread button is included only when the matrix said
  // dm-with-request (neither side refused threads AND neither
  // pre-consented enough to go thread-immediately).
  if (deliveryStatus === 'failed') {
    try {
      const dmPayload = buildProposalMessage(
        {
          tradeId: id,
          proposerHandle: proposer.handle,
          proposerUsername: proposer.username,
          offeringCards,
          receivingCards,
          message,
        },
        {
          includeRequestThreadButton: delivery === 'dm-with-request',
          includePrefsButton: true,
        },
      );
      const posted = await bot.sendDirectMessage(recipient.discordId, dmPayload);
      channelId = posted.channel_id;
      messageId = posted.id;
      deliveryStatus = 'delivered';
    } catch (err) {
      console.error('handlePropose: DM send failed', err);
      await reportError({
        source: 'trades.propose.dm-send',
        tags: { tradeId: id, proposerId: session.userId, recipientId: recipient.id },
      }, err);
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
  await recordEvent(db, {
    proposalId: id,
    actorUserId: null,
    type: deliveryStatus === 'delivered' ? 'delivered_ok' : 'delivered_failed',
    payload: deliveryStatus === 'delivered'
      ? { channel: threadId ? 'thread' : 'dm' }
      : undefined,
  });

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
    // Thread metadata for the "Open in Discord" affordance on the
    // detail view. Null when the proposal went the DM-fallback path.
    discordThreadId: row.discordThreadId,
    discordThreadParentChannelId: row.discordThreadParentChannelId,
    proposer: proposer ?? null,
    recipient: recipient ?? null,
    viewerIsProposer: row.proposerUserId === session.userId,
    viewerIsRecipient: row.recipientUserId === session.userId,
    // Activity timeline — oldest-first, each event carries the actor
    // stub + free-form payload. Empty for proposals that predate the
    // proposal_events table (no backfill).
    events: await listEvents(db, row.id),
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
    // Preview = the highest-priced card across both sides. Null pricing
    // sorts last. Used by the Home list so repeat rows from the same
    // sender don't look identical — a concrete card name anchors each.
    const allCards = [...r.offeringCards, ...r.receivingCards];
    const topCard = allCards.length === 0
      ? null
      : allCards.reduce((best, c) => {
          const bestPrice = best.unitPrice ?? -1;
          const cPrice = c.unitPrice ?? -1;
          return cPrice > bestPrice ? c : best;
        });
    return {
      id: r.id,
      direction,
      status: r.status,
      counterOfId: r.counterOfId,
      offeringCount: r.offeringCards.reduce((n, c) => n + c.qty, 0),
      receivingCount: r.receivingCards.reduce((n, c) => n + c.qty, 0),
      hasMessage: !!r.message,
      topCard: topCard ? { name: topCard.name, variant: topCard.variant } : null,
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
  await recordEvent(db, {
    proposalId: id,
    actorUserId: session.userId,
    type: 'cancelled',
  });

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
            proposerUserId: row.proposerUserId,
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
      await reportError({
        source: 'trades.cancel.dm-edit',
        tags: { tradeId: id, proposerId: session.userId },
      }, err);
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
  await recordEvent(db, {
    proposalId: counterId,
    actorUserId: session.userId,
    type: 'created',
    payload: { counterOfId: original.id },
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
  await recordEvent(db, {
    proposalId: original.id,
    actorUserId: session.userId,
    type: 'countered',
    payload: { counterId },
  });

  // DM side-effects (best effort, never 5xx this call)
  const bot = deps.bot ?? createDiscordBotClient();

  // 1) Edit the original's DM to strip buttons + show countered
  //    status. Only if we actually have a message id to edit.
  if (original.discordDmChannelId && original.discordDmMessageId) {
    try {
      const patched = buildCounteredProposalMessage(
        {
          tradeId: original.id,
          proposerUserId: original.proposerUserId,
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
      await reportError({
        source: 'trades.counter.edit-original',
        tags: { originalTradeId: original.id, counterTradeId: counterId },
      }, err);
    }
  }

  // 2) Send the new counter DM to the original proposer.
  let counterDeliveryStatus: 'delivered' | 'failed' = 'failed';
  let counterChannelId: string | null = null;
  let counterMessageId: string | null = null;
  try {
    const counterDm = buildCounterProposalMessage({
      tradeId: counterId,
      proposerUserId: original.recipientUserId, // counter's proposer = original's recipient
      proposerHandle: originalRecipient.handle,
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
    await reportError({
      source: 'trades.counter.dm-send',
      tags: { counterTradeId: counterId, originalTradeId: original.id },
    }, err);
  }

  await db.update(tradeProposals)
    .set({
      deliveryStatus: counterDeliveryStatus,
      discordDmChannelId: counterChannelId,
      discordDmMessageId: counterMessageId,
      updatedAt: new Date(),
    })
    .where(eq(tradeProposals.id, counterId));
  await recordEvent(db, {
    proposalId: counterId,
    actorUserId: null,
    type: counterDeliveryStatus === 'delivered' ? 'delivered_ok' : 'delivered_failed',
  });

  return res.status(201).json({ id: counterId, deliveryStatus: counterDeliveryStatus });
}

// --- edit (Phase 4c — proposer tweaks a still-pending proposal) -------------

const EditBodySchema = z.object({
  id: z.string().min(1),
  offeringCards: z.array(TradeCardSnapshotSchema),
  receivingCards: z.array(TradeCardSnapshotSchema),
  message: z.string().max(500).optional(),
}).refine(
  data => data.offeringCards.length > 0 || data.receivingCards.length > 0,
  { message: 'Proposal must include at least one card' },
);

/**
 * Proposer-only. Mutates an existing `pending` proposal in place —
 * cards and/or message — and re-renders the delivered Discord
 * message so the recipient sees the updated offer without a new
 * notification channel. Status and respondedAt are untouched.
 *
 * Preconditions: status === 'pending' AND responded_at IS NULL.
 * Anything else 409s. Recipient is fixed at creation time and
 * cannot be edited here — a recipient change would be a new
 * proposal, not an edit.
 *
 * The Discord re-render is best-effort (same pattern as cancel).
 * If the bot call fails, the row still updates and the event is
 * still recorded; the proposer gets 200 and the DM just shows
 * stale content until next action.
 */
export async function handleEdit(
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

  const parsed = EditBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() });
  }
  const { id, offeringCards, receivingCards, message } = parsed.data;

  const db = getDb();
  const [row] = await db
    .select()
    .from(tradeProposals)
    .where(eq(tradeProposals.id, id))
    .limit(1);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.proposerUserId !== session.userId) {
    return res.status(403).json({ error: 'Only the proposer can edit' });
  }
  if (row.status !== 'pending' || row.respondedAt !== null) {
    return res.status(409).json({
      error: 'already-resolved',
      detail: `This proposal is ${row.status} and can no longer be edited.`,
    });
  }

  // Compute what actually changed so the event payload is honest. JSON
  // stringify is stable for our snapshot shape (deterministic key order
  // from the schema) and cheap enough vs the DB round-trip.
  const cardsChanged =
    JSON.stringify(row.offeringCards) !== JSON.stringify(offeringCards) ||
    JSON.stringify(row.receivingCards) !== JSON.stringify(receivingCards);
  const newMessage = message ?? null;
  const messageChanged = (row.message ?? null) !== newMessage;

  await db
    .update(tradeProposals)
    .set({
      offeringCards,
      receivingCards,
      message: newMessage,
      updatedAt: new Date(),
    })
    .where(eq(tradeProposals.id, id));

  await recordEvent(db, {
    proposalId: id,
    actorUserId: session.userId,
    type: 'edited',
    payload: { cardsChanged, messageChanged },
  });

  // Re-render the delivered Discord message in place. Works for both
  // DM-backed and thread-backed proposals: the thread's message id is
  // stored in the same channel/message columns (channel_id = thread_id
  // for thread-backed rows). Keep the Accept/Counter/Decline buttons
  // intact — status is still pending.
  if (row.discordDmChannelId && row.discordDmMessageId) {
    try {
      const [proposer] = await db
        .select({ handle: users.handle, username: users.username })
        .from(users)
        .where(eq(users.id, row.proposerUserId))
        .limit(1);
      if (proposer) {
        const bot = deps.bot ?? createDiscordBotClient();
        const patched = buildProposalMessage({
          tradeId: row.id,
          proposerUserId: row.proposerUserId,
          proposerHandle: proposer.handle,
          proposerUsername: proposer.username,
          offeringCards,
          receivingCards,
          message: newMessage,
        });
        await bot.editChannelMessage(row.discordDmChannelId, row.discordDmMessageId, patched);
      }
    } catch (err) {
      console.error('handleEdit: Discord message edit failed', err);
      await reportError({
        source: 'trades.edit.message-edit',
        tags: { tradeId: id, proposerId: session.userId },
      }, err);
    }
  }

  return res.json({ id, status: 'pending' });
}
