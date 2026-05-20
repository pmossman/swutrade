import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { wantsItems, users } from '../lib/schema.js';
import { getSession } from '../lib/auth.js';

/**
 * Given a list of binder rows (productId + familyId + variant),
 * returns per-productId stats about who else wants this exact card:
 *
 *   { counts: { [productId]: { count: number, users: PublicUser[] } } }
 *
 * The match is RESTRICTION-AWARE: a want with `restriction.restricted
 * = ['Hyperspace Foil']` does NOT count toward a Standard binder
 * row, even though they share a familyId. The old shape stripped
 * restrictions and counted every same-family want indiscriminately —
 * a Standard Cad Bane in your binder would show "1 wants this" even
 * if the only wanter wanted it in Hyperspace Foil. Mirrors the
 * community-overlap chip fix (5f91f2f) so the two surfaces agree on
 * what "match" means.
 *
 * Privacy:
 *   - Only `wantsPublic=true` users count.
 *   - `profileVisibility='private'` users are EXCLUDED from the user
 *     list (they're explicitly hidden from this kind of discovery)
 *     but they DO still contribute to the count — the count is a
 *     statistical signal, the user list is the discovery surface.
 *   - The caller is always excluded from both count + user list when
 *     signed in.
 *
 * User list capped at MAX_USERS_PER_ROW to keep response payloads
 * predictable for very popular cards. The count tells the full
 * story; the user list surfaces the first N for actionability.
 */

const MAX_USERS_PER_ROW = 10;

type RestrictionMode = 'any' | 'restricted';

interface PopularWantsItem {
  productId: string;
  familyId: string;
  variant: string;
}

interface PublicUser {
  handle: string;
  username: string;
  avatarUrl: string | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as { items?: unknown } | null;
  const items = parseItems(body?.items);

  if (items.length === 0) {
    return res.json({ counts: {} });
  }

  const session = await getSession(req, res);
  const viewerId = session?.userId ?? null;

  const familyIds = Array.from(new Set(items.map(i => i.familyId)));
  const db = getDb();

  // Pull every public want for the requested families, joined to the
  // user's identity + visibility settings. We do the restriction
  // matching in JS rather than SQL because the restriction-variants
  // column is a text[] and the per-row comparison ("does variant X
  // appear in this array?") is fiddly in Drizzle's query API.
  // Families are small in the wild (a few thousand wants total per
  // active community), so the over-fetch is cheap.
  const conditions = [
    inArray(wantsItems.familyId, familyIds),
    eq(users.wantsPublic, true),
  ];
  if (viewerId) conditions.push(ne(wantsItems.userId, viewerId));

  const rows = await db
    .select({
      familyId: wantsItems.familyId,
      restrictionMode: wantsItems.restrictionMode,
      restrictionVariants: wantsItems.restrictionVariants,
      userId: wantsItems.userId,
      handle: users.handle,
      username: users.username,
      avatarUrl: users.avatarUrl,
      profileVisibility: users.profileVisibility,
    })
    .from(wantsItems)
    .innerJoin(users, eq(users.id, wantsItems.userId))
    .where(and(...conditions));

  const counts: Record<string, { count: number; users: PublicUser[] }> = {};

  for (const item of items) {
    const matchingUserIds = new Set<string>();
    const surfaceableUsers: PublicUser[] = [];
    const seenSurfaceable = new Set<string>();

    for (const row of rows) {
      if (row.familyId !== item.familyId) continue;
      if (!variantSatisfiesRestriction(item.variant, row.restrictionMode as RestrictionMode, row.restrictionVariants)) {
        continue;
      }
      matchingUserIds.add(row.userId);
      if (row.profileVisibility !== 'private'
          && !seenSurfaceable.has(row.userId)
          && surfaceableUsers.length < MAX_USERS_PER_ROW) {
        seenSurfaceable.add(row.userId);
        surfaceableUsers.push({
          handle: row.handle,
          username: row.username,
          avatarUrl: row.avatarUrl,
        });
      }
    }

    if (matchingUserIds.size > 0) {
      counts[item.productId] = {
        count: matchingUserIds.size,
        users: surfaceableUsers,
      };
    }
  }

  res.setHeader('Cache-Control', 'private, s-maxage=30, stale-while-revalidate=120');
  res.json({ counts });
}

function parseItems(raw: unknown): PopularWantsItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PopularWantsItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.productId !== 'string' || !e.productId) continue;
    if (typeof e.familyId !== 'string' || !e.familyId) continue;
    if (typeof e.variant !== 'string' || !e.variant) continue;
    out.push({ productId: e.productId, familyId: e.familyId, variant: e.variant });
  }
  return out;
}

function variantSatisfiesRestriction(
  variant: string,
  mode: RestrictionMode,
  variants: string[] | null | undefined,
): boolean {
  if (mode === 'any') return true;
  if (mode === 'restricted') {
    if (!variants || variants.length === 0) return false;
    return variants.includes(variant);
  }
  return false;
}
