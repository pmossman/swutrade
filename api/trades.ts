import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { requireSession } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import { trades, tradeProposals, users, type TradeCardSnapshot } from '../lib/schema.js';

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
 * What this does NOT do yet (slice 3): DM the recipient via the bot,
 * render the proposal with Accept/Decline buttons, thread state
 * changes back. For now the proposer sees a confirmation; the
 * recipient has to be told out-of-band.
 */
export async function handlePropose(req: VercelRequest, res: VercelResponse) {
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
    .select({ id: users.id, profileVisibility: users.profileVisibility })
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

  const id = crypto.randomUUID();
  await db.insert(tradeProposals).values({
    id,
    proposerUserId: session.userId,
    recipientUserId: recipient.id,
    status: 'pending',
    offeringCards,
    receivingCards,
    message: message ?? null,
  });

  return res.status(201).json({ id });
}
