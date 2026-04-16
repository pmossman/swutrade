import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq, and, notInArray } from 'drizzle-orm';
import { requireSession } from '../../lib/auth.js';
import { getDb } from '../../lib/db.js';
import { wantsItems } from '../../lib/schema.js';
import { restrictionKey } from '../../lib/shared.js';

interface WantsItemPayload {
  id: string;
  familyId: string;
  qty: number;
  restriction: { mode: string; variants?: string[] };
  maxUnitPrice?: number;
  note?: string;
  isPriority?: boolean;
  addedAt: number;
}

function toDbRow(item: WantsItemPayload, userId: string) {
  return {
    id: item.id,
    userId,
    familyId: item.familyId,
    qty: Math.min(99, Math.max(1, item.qty)),
    restrictionMode: item.restriction.mode,
    restrictionVariants: item.restriction.mode === 'restricted'
      ? item.restriction.variants ?? []
      : null,
    restrictionKey: restrictionKey(item.restriction),
    maxUnitPrice: item.maxUnitPrice?.toString() ?? null,
    note: item.note ?? null,
    isPriority: item.isPriority ?? false,
    addedAt: item.addedAt,
    updatedAt: new Date(),
  };
}

function toClientShape(row: typeof wantsItems.$inferSelect): WantsItemPayload {
  return {
    id: row.id,
    familyId: row.familyId,
    qty: row.qty,
    restriction: row.restrictionMode === 'restricted'
      ? { mode: 'restricted' as const, variants: row.restrictionVariants ?? [] }
      : { mode: 'any' as const },
    ...(row.maxUnitPrice != null ? { maxUnitPrice: Number(row.maxUnitPrice) } : {}),
    ...(row.note ? { note: row.note } : {}),
    ...(row.isPriority ? { isPriority: true } : {}),
    addedAt: row.addedAt,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  if (req.method === 'GET') {
    const rows = await db.select().from(wantsItems)
      .where(eq(wantsItems.userId, session.userId));
    return res.json(rows.map(toClientShape));
  }

  if (req.method === 'PUT') {
    const items = req.body as WantsItemPayload[];
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Body must be an array of wants items' });
    }

    const clientIds = items.map(i => i.id).filter(Boolean);

    // Upsert all client items.
    for (const item of items) {
      if (!item.id || !item.familyId) continue;
      const row = toDbRow(item, session.userId);
      await db.insert(wantsItems).values(row)
        .onConflictDoUpdate({
          target: wantsItems.id,
          set: {
            qty: row.qty,
            restrictionMode: row.restrictionMode,
            restrictionVariants: row.restrictionVariants,
            restrictionKey: row.restrictionKey,
            maxUnitPrice: row.maxUnitPrice,
            note: row.note,
            isPriority: row.isPriority,
            addedAt: row.addedAt,
            updatedAt: row.updatedAt,
          },
        });
    }

    // Delete server items not in the client payload (full-list sync).
    if (clientIds.length > 0) {
      await db.delete(wantsItems).where(
        and(
          eq(wantsItems.userId, session.userId),
          notInArray(wantsItems.id, clientIds),
        ),
      );
    } else {
      // Client sent empty list → clear all server items.
      await db.delete(wantsItems).where(eq(wantsItems.userId, session.userId));
    }

    // Return canonical server state.
    const rows = await db.select().from(wantsItems)
      .where(eq(wantsItems.userId, session.userId));
    return res.json(rows.map(toClientShape));
  }

  res.status(405).json({ error: 'Method not allowed' });
}
