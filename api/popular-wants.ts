import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { wantsItems, users } from '../lib/schema.js';
import { getSession } from '../lib/auth.js';

/**
 * Given a list of familyIds (typically the caller's Available list),
 * returns `{ familyId: userCount }` for each family that at least one
 * other user has on their public wants list. Families with no matches
 * are omitted to keep the response small.
 *
 * Excludes the caller from the count so "3 people want this" never
 * includes the viewer themselves.
 *
 * Response: `{ counts: { [familyId]: number } }`.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as { familyIds?: unknown } | null;
  const familyIds = Array.isArray(body?.familyIds)
    ? body!.familyIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];

  if (familyIds.length === 0) {
    return res.json({ counts: {} });
  }

  // Caller is optional: anonymous users still see counts (wants are
  // public data). When a user IS signed in we exclude their own
  // wants from the tally so they don't see "1 person wants this"
  // where the one person is themselves.
  const session = await getSession(req, res);
  const viewerId = session?.userId ?? null;

  const db = getDb();
  const conditions = [
    inArray(wantsItems.familyId, familyIds),
    eq(users.wantsPublic, true),
  ];
  if (viewerId) conditions.push(ne(wantsItems.userId, viewerId));

  const rows = await db
    .select({
      familyId: wantsItems.familyId,
      userCount: sql<number>`count(distinct ${wantsItems.userId})::int`,
    })
    .from(wantsItems)
    .innerJoin(users, eq(users.id, wantsItems.userId))
    .where(and(...conditions))
    .groupBy(wantsItems.familyId);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.userCount > 0) counts[row.familyId] = row.userCount;
  }

  // Short cache — counts shift as users edit lists, but not second-by-second.
  res.setHeader('Cache-Control', 'private, s-maxage=30, stale-while-revalidate=120');
  res.json({ counts });
}
