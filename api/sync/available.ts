import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq, and, notInArray } from 'drizzle-orm';
import { requireSession } from '../../lib/auth.js';
import { getDb } from '../../lib/db.js';
import { availableItems } from '../../lib/schema.js';

interface AvailableItemPayload {
  id: string;
  productId: string;
  qty: number;
  note?: string;
  addedAt: number;
}

function toDbRow(item: AvailableItemPayload, userId: string) {
  return {
    id: item.id,
    userId,
    productId: item.productId,
    qty: Math.min(99, Math.max(1, item.qty)),
    note: item.note ?? null,
    addedAt: item.addedAt,
    updatedAt: new Date(),
  };
}

function toClientShape(row: typeof availableItems.$inferSelect): AvailableItemPayload {
  return {
    id: row.id,
    productId: row.productId,
    qty: row.qty,
    ...(row.note ? { note: row.note } : {}),
    addedAt: row.addedAt,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  if (req.method === 'GET') {
    const rows = await db.select().from(availableItems)
      .where(eq(availableItems.userId, session.userId));
    return res.json(rows.map(toClientShape));
  }

  if (req.method === 'PUT') {
    const items = req.body as AvailableItemPayload[];
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Body must be an array of available items' });
    }

    const clientIds = items.map(i => i.id).filter(Boolean);

    for (const item of items) {
      if (!item.id || !item.productId) continue;
      const row = toDbRow(item, session.userId);
      await db.insert(availableItems).values(row)
        .onConflictDoUpdate({
          target: availableItems.id,
          set: {
            qty: row.qty,
            note: row.note,
            addedAt: row.addedAt,
            updatedAt: row.updatedAt,
          },
        });
    }

    if (clientIds.length > 0) {
      await db.delete(availableItems).where(
        and(
          eq(availableItems.userId, session.userId),
          notInArray(availableItems.id, clientIds),
        ),
      );
    } else {
      await db.delete(availableItems).where(eq(availableItems.userId, session.userId));
    }

    const rows = await db.select().from(availableItems)
      .where(eq(availableItems.userId, session.userId));
    return res.json(rows.map(toClientShape));
  }

  res.status(405).json({ error: 'Method not allowed' });
}
