import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { requireSession } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import { trades, tradeProposals, users, type TradeCardSnapshot } from '../lib/schema.js';
import { createDiscordBotClient, type DiscordBotClient } from '../lib/discordBot.js';
import { buildProposalMessage } from '../lib/proposalMessages.js';

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
    case '':         return handleSavedTrades(req, res);
    case 'propose':  return handlePropose(req, res);
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

  // Fire the DM. Errors never 5xx the propose call — the row is
  // already persisted and the proposer should still get a 201.
  // The client reads delivery_status to decide whether to show a
  // "saved but couldn't DM" fallback.
  let deliveryStatus: 'delivered' | 'failed' = 'failed';
  let channelId: string | null = null;
  let messageId: string | null = null;
  try {
    const bot = deps.bot ?? createDiscordBotClient();
    const payload = buildProposalMessage({
      tradeId: id,
      proposerHandle: proposer.handle,
      proposerUsername: proposer.username,
      offeringCards,
      receivingCards,
      message,
    });
    const posted = await bot.sendDirectMessage(recipient.discordId, payload);
    channelId = posted.channel_id;
    messageId = posted.id;
    deliveryStatus = 'delivered';
  } catch (err) {
    console.error('handlePropose: DM send failed', err);
  }

  await db.update(tradeProposals)
    .set({
      deliveryStatus,
      discordDmChannelId: channelId,
      discordDmMessageId: messageId,
      updatedAt: new Date(),
    })
    .where(eq(tradeProposals.id, id));

  return res.status(201).json({ id, deliveryStatus });
}
