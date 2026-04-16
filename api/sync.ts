import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq, and, notInArray } from 'drizzle-orm';
import { requireSession } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import { wantsItems, availableItems } from '../lib/schema.js';
import { restrictionKey } from '../lib/shared.js';

/**
 * Consolidated /api/sync dispatcher — one function covers both
 * wants and available sync surfaces. See api/me.ts for the same
 * pattern and rationale (serverless function-count ceiling).
 * Pretty URLs preserved via vercel.json rewrites:
 *   /api/sync/wants     → /api/sync?kind=wants
 *   /api/sync/available → /api/sync?kind=available
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const kind = (req.query.kind as string | undefined) ?? '';
  if (kind === 'wants') return handleWants(req, res);
  if (kind === 'available') return handleAvailable(req, res);
  return res.status(404).json({ error: 'Unknown /api/sync kind' });
}

// --- wants ------------------------------------------------------------------

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

function wantsToDbRow(item: WantsItemPayload, userId: string) {
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

function wantsToClientShape(row: typeof wantsItems.$inferSelect): WantsItemPayload {
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

export async function handleWants(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  if (req.method === 'GET') {
    const rows = await db.select().from(wantsItems)
      .where(eq(wantsItems.userId, session.userId));
    return res.json(rows.map(wantsToClientShape));
  }

  if (req.method === 'PUT') {
    const items = req.body as WantsItemPayload[];
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Body must be an array of wants items' });
    }

    const clientIds = items.map(i => i.id).filter(Boolean);

    for (const item of items) {
      if (!item.id || !item.familyId) continue;
      const row = wantsToDbRow(item, session.userId);
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

    if (clientIds.length > 0) {
      await db.delete(wantsItems).where(
        and(
          eq(wantsItems.userId, session.userId),
          notInArray(wantsItems.id, clientIds),
        ),
      );
    } else {
      await db.delete(wantsItems).where(eq(wantsItems.userId, session.userId));
    }

    const rows = await db.select().from(wantsItems)
      .where(eq(wantsItems.userId, session.userId));
    return res.json(rows.map(wantsToClientShape));
  }

  res.status(405).json({ error: 'Method not allowed' });
}

// --- available --------------------------------------------------------------

interface AvailableItemPayload {
  id: string;
  productId: string;
  qty: number;
  note?: string;
  addedAt: number;
}

function availableToDbRow(item: AvailableItemPayload, userId: string) {
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

function availableToClientShape(row: typeof availableItems.$inferSelect): AvailableItemPayload {
  return {
    id: row.id,
    productId: row.productId,
    qty: row.qty,
    ...(row.note ? { note: row.note } : {}),
    addedAt: row.addedAt,
  };
}

export async function handleAvailable(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  if (req.method === 'GET') {
    const rows = await db.select().from(availableItems)
      .where(eq(availableItems.userId, session.userId));
    return res.json(rows.map(availableToClientShape));
  }

  if (req.method === 'PUT') {
    const items = req.body as AvailableItemPayload[];
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Body must be an array of available items' });
    }

    const clientIds = items.map(i => i.id).filter(Boolean);

    for (const item of items) {
      if (!item.id || !item.productId) continue;
      const row = availableToDbRow(item, session.userId);
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
    return res.json(rows.map(availableToClientShape));
  }

  res.status(405).json({ error: 'Method not allowed' });
}
