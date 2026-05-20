import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { wantsItems, availableItems, users } from '../lib/schema.js';
import { getSession } from '../lib/auth.js';
import { lookupSignalCard } from '../lib/signalMatching.js';
import familyIndex from '../public/data/family-index.json' with { type: 'json' };

/**
 * Two symmetric trader-discovery queries dispatched off the `action`
 * query param (rewritten from `/api/popular-wants` and
 * `/api/popular-haves` by vercel.json — single function file so the
 * deploy stays under the Hobby plan's function-count ceiling):
 *
 *   action=wants  — binder direction. Given binder rows
 *                   [{productId, familyId, variant}], returns
 *                   per-productId other users whose restriction
 *                   would actually accept this binder row's variant.
 *
 *   action=haves  — wishlist direction. Given wishlist rows
 *                   [{rowId, familyId, restriction}], returns
 *                   per-rowId other users whose binder has a
 *                   variant that satisfies the restriction.
 *
 * Both endpoints share the response shape:
 *
 *   { counts: { [rowKey]: { count: number, users: PublicUser[] } } }
 *
 * Privacy convention (both directions):
 *   - Only the relevant `*Public=true` users count
 *     (`wantsPublic` for the wants direction, `availablePublic` for
 *     haves).
 *   - `profileVisibility='private'` users are EXCLUDED from the
 *     surfaced user list but their want / available row still
 *     contributes to the count — count is a statistical signal, the
 *     user list is the discovery surface.
 *   - Caller is always excluded from both count + user list when
 *     signed in.
 *
 * User list capped at MAX_USERS_PER_ROW to keep response payloads
 * predictable for very popular cards. The count tells the full
 * story; the user list surfaces the first N for actionability.
 */

const MAX_USERS_PER_ROW = 10;

type RestrictionMode = 'any' | 'restricted';

interface PublicUser {
  handle: string;
  username: string;
  avatarUrl: string | null;
}

interface FamilyEntry {
  p: string;
  v: string;
  m: number | null;
  l: number | null;
  n: string;
  t?: string;
}
type FamilyIndex = Record<string, FamilyEntry[]>;
const FAMS = familyIndex as FamilyIndex;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Default to the wants direction so the old call shape (the only
  // one that existed before 2026-05-20) still works when callers
  // haven't been updated. New callers should pass the action
  // explicitly.
  const action = (req.query?.action as string | undefined) ?? 'wants';
  if (action === 'wants') return handleWantsDirection(req, res);
  if (action === 'haves') return handleHavesDirection(req, res);
  return res.status(404).json({ error: 'Unknown action' });
}

// --- wants direction (binder rows → who wants them) ------------------

interface WantsDirectionItem {
  productId: string;
  familyId: string;
  variant: string;
}

async function handleWantsDirection(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { items?: unknown } | null;
  const items = parseWantsItems(body?.items);
  if (items.length === 0) return res.json({ counts: {} });

  const session = await getSession(req, res);
  const viewerId = session?.userId ?? null;
  const familyIds = Array.from(new Set(items.map(i => i.familyId)));

  const db = getDb();
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
      counts[item.productId] = { count: matchingUserIds.size, users: surfaceableUsers };
    }
  }

  res.setHeader('Cache-Control', 'private, s-maxage=30, stale-while-revalidate=120');
  res.json({ counts });
}

function parseWantsItems(raw: unknown): WantsDirectionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: WantsDirectionItem[] = [];
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

// --- haves direction (wishlist rows → who has them) ------------------

interface HavesDirectionItem {
  rowId: string;
  familyId: string;
  restrictionMode: RestrictionMode;
  restrictionVariants?: string[] | null;
}

async function handleHavesDirection(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { items?: unknown } | null;
  const items = parseHavesItems(body?.items);
  if (items.length === 0) return res.json({ counts: {} });

  const session = await getSession(req, res);
  const viewerId = session?.userId ?? null;

  // Collect every productId across the requested families up-front
  // so the SQL scan is narrowed to just those prints. availableItems
  // is productId-keyed; we don't have a familyId column on it.
  const allProductIds = new Set<string>();
  for (const item of items) {
    const entries = FAMS[item.familyId];
    if (!entries) continue;
    for (const e of entries) allProductIds.add(e.p);
  }
  if (allProductIds.size === 0) return res.json({ counts: {} });

  const db = getDb();
  const conditions = [
    inArray(availableItems.productId, Array.from(allProductIds)),
    eq(users.availablePublic, true),
  ];
  if (viewerId) conditions.push(ne(availableItems.userId, viewerId));

  const rows = await db
    .select({
      productId: availableItems.productId,
      userId: availableItems.userId,
      handle: users.handle,
      username: users.username,
      avatarUrl: users.avatarUrl,
      profileVisibility: users.profileVisibility,
    })
    .from(availableItems)
    .innerJoin(users, eq(users.id, availableItems.userId))
    .where(and(...conditions));

  const counts: Record<string, { count: number; users: PublicUser[] }> = {};
  for (const item of items) {
    const matchingUserIds = new Set<string>();
    const surfaceableUsers: PublicUser[] = [];
    const seenSurfaceable = new Set<string>();
    for (const row of rows) {
      const meta = lookupSignalCard(row.productId);
      if (!meta || meta.familyId !== item.familyId) continue;
      if (!variantSatisfiesRestriction(meta.variant, item.restrictionMode, item.restrictionVariants)) {
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
      counts[item.rowId] = { count: matchingUserIds.size, users: surfaceableUsers };
    }
  }

  res.setHeader('Cache-Control', 'private, s-maxage=30, stale-while-revalidate=120');
  res.json({ counts });
}

function parseHavesItems(raw: unknown): HavesDirectionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: HavesDirectionItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.rowId !== 'string' || !e.rowId) continue;
    if (typeof e.familyId !== 'string' || !e.familyId) continue;
    const mode = e.restrictionMode;
    if (mode !== 'any' && mode !== 'restricted') continue;
    const variants = Array.isArray(e.restrictionVariants)
      ? (e.restrictionVariants.filter((x): x is string => typeof x === 'string'))
      : null;
    out.push({
      rowId: e.rowId,
      familyId: e.familyId,
      restrictionMode: mode,
      restrictionVariants: variants,
    });
  }
  return out;
}

// --- shared ----------------------------------------------------------

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
