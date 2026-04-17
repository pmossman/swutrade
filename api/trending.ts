import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { wantsItems } from '../lib/schema.js';
import { users } from '../lib/schema.js';

/**
 * Returns the most-wanted card families across all users with public
 * wants lists. Aggregates by family_id, counts distinct users (not
 * total qty — "5 people want this" is more compelling than "12 total
 * copies wanted"). Limited to top 20.
 *
 * Response shape: [{ familyId, userCount, totalQty }]
 * Cached aggressively — community trends don't need real-time freshness.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const db = getDb();

  // Exclude dev-seed fake accounts (from scripts/dev-seed-community.mjs)
  // from community-wide aggregates. They exist for directory / profile
  // smoke-testing and would otherwise skew trending with synthetic data.
  const rows = await db.execute(sql`
    SELECT
      w.family_id AS "familyId",
      COUNT(DISTINCT w.user_id)::int AS "userCount",
      SUM(w.qty)::int AS "totalQty"
    FROM ${wantsItems} w
    JOIN ${users} u ON u.id = w.user_id AND u.wants_public = true
    WHERE u.id NOT LIKE 'dev-seed-%'
    GROUP BY w.family_id
    ORDER BY COUNT(DISTINCT w.user_id) DESC, SUM(w.qty) DESC
    LIMIT 20
  `);

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.json(rows.rows);
}
