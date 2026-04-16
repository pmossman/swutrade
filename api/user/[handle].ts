import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { getDb } from '../../lib/db.js';
import { users, wantsItems, availableItems } from '../../lib/schema.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { handle } = req.query as { handle: string };
  if (!handle) return res.status(400).json({ error: 'Missing handle' });

  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.handle, handle)).limit(1);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const wants = user.wantsPublic
    ? (await db.select().from(wantsItems).where(eq(wantsItems.userId, user.id))).map(row => ({
        familyId: row.familyId,
        qty: row.qty,
        restriction: row.restrictionMode === 'restricted'
          ? { mode: 'restricted' as const, variants: row.restrictionVariants ?? [] }
          : { mode: 'any' as const },
        isPriority: row.isPriority ?? undefined,
      }))
    : null;

  const available = user.availablePublic
    ? (await db.select().from(availableItems).where(eq(availableItems.userId, user.id))).map(row => ({
        productId: row.productId,
        qty: row.qty,
      }))
    : null;

  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.json({
    user: {
      username: user.username,
      handle: user.handle,
      avatarUrl: user.avatarUrl,
    },
    wants,
    available,
  });
}
