import type { VercelRequest, VercelResponse } from '@vercel/node';
import { desc, eq } from 'drizzle-orm';
import { requireSession } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import { trades, type TradeCardSnapshot } from '../lib/schema.js';

/**
 * `/api/trades` — personal "save this trade" history endpoint.
 * GET lists the signed-in viewer's saved trades, POST saves a new
 * snapshot from the trade-summary surface. Independent of any
 * counterparty (sessions handle bilateral trades).
 */
interface SaveTradeBody {
  yourCards: TradeCardSnapshot[];
  theirCards: TradeCardSnapshot[];
  percentage: number;
  priceMode: string;
  totalYours: number;
  totalTheirs: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
