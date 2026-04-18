import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { users, userGuildMemberships, botInstalledGuilds, wantsItems, availableItems } from '../lib/schema.js';
import { requireSession, getDiscordAccessToken } from '../lib/auth.js';
import { syncGuildMemberships } from '../lib/guildSync.js';
import { createDiscordClient, type DiscordClient } from '../lib/discordClient.js';
import {
  PREF_DEFINITIONS,
  getPrefDefinition,
  validatePrefValue,
} from '../lib/prefsRegistry.js';

/**
 * Single dispatcher for every `/api/me/*` endpoint.
 *
 * Vercel's file-based routing makes each `.ts` under `api/` a separate
 * serverless function; Hobby caps at 12 functions per deployment.
 * Bundling the signed-in-user surface under one file keeps us under
 * the ceiling. `vercel.json` rewrites preserve the pretty URLs
 * externally so clients still call `/api/me/settings` etc.
 *
 * Dispatch happens on the `action` query param (set by the rewrite
 * rule); the underlying sub-handlers are kept short and inline.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = (req.query.action as string | undefined) ?? '';

  switch (action) {
    case 'prefs':
      return handlePrefs(req, res);
    case 'settings':
      // Deprecated alias: /api/me/settings routes here during the
      // transition so stale browser builds keep working. Remove once
      // deployed clients have had a release to migrate to /prefs.
      return handlePrefs(req, res);
    case 'guilds':
      return handleGuildsList(req, res);
    case 'guilds-refresh':
      return handleGuildsRefresh(req, res);
    case 'guild':
      return handleGuildPut(req, res);
    case 'community':
      return handleCommunity(req, res);
    case 'community-members':
      return handleCommunityMembers(req, res);
    default:
      return res.status(404).json({ error: 'Unknown /api/me action' });
  }
}

// --- prefs ------------------------------------------------------------------

/**
 * Registry-driven GET + PUT for every self-scoped pref the app knows
 * about. Both the `prefs` and deprecated `settings` actions route
 * here; the only difference is the URL the caller hit.
 *
 * GET: project the registered columns off the users row, return as
 *   `{ [key]: value }`.
 * PUT: accept a partial `{ [key]: value }` patch; every key must match
 *   a self-scoped registered def and its value must pass the type
 *   check. Unknown keys fail the whole request — the registry is the
 *   contract, and silently dropping unrecognized keys hides typos.
 *
 * Peer-scoped prefs are handled separately in a later migration step.
 */
export async function handlePrefs(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  const selfDefs = PREF_DEFINITIONS.filter(d => d.scope.kind === 'self');

  if (req.method === 'GET') {
    // Cast once so we can dynamically project the Drizzle column
    // objects by name — the registry's `column` values are validated
    // against the users table schema at test time so the runtime
    // property access is safe.
    const usersCols = users as unknown as Record<string, import('drizzle-orm/pg-core').AnyPgColumn>;
    const projection: Record<string, import('drizzle-orm/pg-core').AnyPgColumn> = {};
    for (const def of selfDefs) {
      projection[def.key] = usersCols[def.column];
    }

    const [row] = await db
      .select(projection)
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(row);
  }

  if (req.method === 'PUT') {
    if (typeof req.body !== 'object' || req.body == null || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid body' });
    }
    const patch = req.body as Record<string, unknown>;
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      return res.status(400).json({ error: 'Empty patch' });
    }

    // Validate every key against the registry before writing anything.
    // A single bad key rejects the whole request — partial writes on
    // validation failure would leave the client guessing which fields
    // landed.
    const updates: Record<string, boolean | string> = {};
    for (const key of keys) {
      const def = getPrefDefinition(key, 'self');
      if (!def) {
        return res.status(400).json({ error: 'Unknown pref', key });
      }
      const v = validatePrefValue(def, patch[key]);
      if (!v.ok) {
        return res.status(400).json({ error: 'Invalid value', key, reason: v.reason });
      }
      updates[def.column] = v.value;
    }

    await db
      .update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.id, session.userId));
    return res.json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * Deprecated alias — retained so existing tests, stale clients, and
 * the `/api/me/settings` URL continue to work during the transition.
 * New callers should import `handlePrefs`. Remove once deployed
 * clients have rolled over to `/api/me/prefs`.
 */
export const handleSettings = handlePrefs;

// --- guilds list ------------------------------------------------------------

export async function handleGuildsList(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  const memberships = await db
    .select()
    .from(userGuildMemberships)
    .where(eq(userGuildMemberships.userId, session.userId));

  const installedIds = new Set(
    (await db.select({ guildId: botInstalledGuilds.guildId }).from(botInstalledGuilds))
      .map(r => r.guildId),
  );

  const enrollable: unknown[] = [];
  const other: unknown[] = [];
  for (const m of memberships) {
    const shape = {
      guildId: m.guildId,
      guildName: m.guildName,
      guildIcon: m.guildIcon,
      canManage: m.canManage,
      enrolled: m.enrolled,
      includeInRollups: m.includeInRollups,
      appearInQueries: m.appearInQueries,
    };
    if (installedIds.has(m.guildId)) enrollable.push(shape);
    else other.push(shape);
  }

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ enrollable, other });
}

// --- guilds re-sync ---------------------------------------------------------

/**
 * POST-only. Re-hits Discord's `/users/@me/guilds` using the access
 * token stored in the session cookie, reconciles `user_guild_memberships`
 * via the shared `syncGuildMemberships` helper, then returns the
 * freshly-updated list in the same shape as GET /api/me/guilds so
 * the client can replace its state in a single roundtrip.
 *
 * Auth failure modes:
 *   - No session           → 401 Not authenticated (from requireSession)
 *   - Session has no token → 409 token-unavailable; caller prompts re-auth
 *   - Token expired        → same 409 (session still valid for normal use)
 *   - Discord returns 401  → same 409 (token revoked server-side)
 *
 * 409 is chosen deliberately over 401 — the user IS authenticated
 * with us, they just can't act on their Discord account right now.
 * Client treats it as "prompt re-auth to refresh" without nuking the
 * whole session.
 *
 * Injectable `discord` param exists only for the tests that ship
 * alongside this endpoint. Production code path uses the default.
 */
export async function handleGuildsRefresh(
  req: VercelRequest,
  res: VercelResponse,
  discord: DiscordClient = createDiscordClient(),
) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const accessToken = await getDiscordAccessToken(req, res);
  if (!accessToken) {
    return res.status(409).json({
      error: 'discord-token-unavailable',
      detail: 'Sign in with Discord again to refresh your server list.',
    });
  }

  try {
    await syncGuildMemberships(session.userId, accessToken, discord, {
      propagateDiscordErrors: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Discord 401 inside the client manifests as a thrown error in
    // getUserGuilds — treat it like token-unavailable so the UI can
    // surface the same re-auth prompt.
    if (/401/.test(msg) || /unauthorized/i.test(msg)) {
      return res.status(409).json({ error: 'discord-token-unavailable', detail: msg });
    }
    console.error('/api/me/guilds-refresh: sync failed', err);
    return res.status(502).json({ error: 'Failed to refresh from Discord' });
  }

  return handleGuildsList(req, res);
}

// --- per-guild patch --------------------------------------------------------

const GuildPatchSchema = z.object({
  enrolled: z.boolean().optional(),
  includeInRollups: z.boolean().optional(),
  appearInQueries: z.boolean().optional(),
});

export async function handleGuildPut(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { guildId } = req.query as { guildId?: string };
  if (!guildId || typeof guildId !== 'string') {
    return res.status(400).json({ error: 'Missing guildId' });
  }

  const parsed = GuildPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() });
  }

  const db = getDb();

  const [installed] = await db
    .select({ guildId: botInstalledGuilds.guildId })
    .from(botInstalledGuilds)
    .where(eq(botInstalledGuilds.guildId, guildId))
    .limit(1);
  if (!installed) {
    return res.status(404).json({ error: 'SWUTrade is not installed in this guild' });
  }

  const [membership] = await db
    .select()
    .from(userGuildMemberships)
    .where(and(
      eq(userGuildMemberships.userId, session.userId),
      eq(userGuildMemberships.guildId, guildId),
    ))
    .limit(1);
  if (!membership) {
    return res.status(404).json({ error: 'User is not a member of this guild' });
  }

  const patch = parsed.data;
  const next = {
    enrolled: patch.enrolled ?? membership.enrolled,
    includeInRollups: patch.includeInRollups ?? membership.includeInRollups,
    appearInQueries: patch.appearInQueries ?? membership.appearInQueries,
  };
  if (patch.enrolled === true && membership.enrolled === false) {
    if (patch.includeInRollups === undefined) next.includeInRollups = true;
    if (patch.appearInQueries === undefined) next.appearInQueries = true;
  }
  if (next.enrolled === false) {
    next.includeInRollups = false;
    next.appearInQueries = false;
  }

  await db
    .update(userGuildMemberships)
    .set(next)
    .where(and(
      eq(userGuildMemberships.userId, session.userId),
      eq(userGuildMemberships.guildId, guildId),
    ));

  return res.json({ ok: true, ...next });
}

// --- community rollup -------------------------------------------------------

/**
 * Aggregated wants + available across other users enrolled in the
 * same Discord guilds as the viewer. Powers the "Community" source
 * chip in the picker: cards members of your enrolled servers want
 * or have available.
 *
 * Response: `{ wantFamilyIds: string[], availableProductIds: string[] }`.
 * Both arrays are deduplicated; the client filters these against
 * its own available / wants to produce actionable matches.
 *
 * Gating:
 *   - Viewer must be enrolled + includeInRollups=true in ≥1 guild
 *     with the bot installed.
 *   - Contributing users must be enrolled + includeInRollups=true in
 *     one of those mutual guilds.
 *   - Wants sourced only from users with wants_public=true; available
 *     only from users with available_public=true. profile_visibility
 *     is not enforced here — it gates the profile page, not the
 *     community rollup, which is a separate consent surface.
 *   - Viewer's own rows are always excluded.
 */
export async function handleCommunity(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  // Viewer's enrolled + rollup-on guilds.
  const viewerGuilds = await db
    .select({ guildId: userGuildMemberships.guildId })
    .from(userGuildMemberships)
    .where(and(
      eq(userGuildMemberships.userId, session.userId),
      eq(userGuildMemberships.enrolled, true),
      eq(userGuildMemberships.includeInRollups, true),
    ));

  if (viewerGuilds.length === 0) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ wantFamilyIds: [], availableProductIds: [] });
  }

  const guildIds = viewerGuilds.map(g => g.guildId);

  // Other users enrolled + rollup-on in any of those guilds.
  const mutualUsers = await db
    .selectDistinct({ userId: userGuildMemberships.userId })
    .from(userGuildMemberships)
    .where(and(
      inArray(userGuildMemberships.guildId, guildIds),
      eq(userGuildMemberships.enrolled, true),
      eq(userGuildMemberships.includeInRollups, true),
      ne(userGuildMemberships.userId, session.userId),
    ));

  if (mutualUsers.length === 0) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ wantFamilyIds: [], availableProductIds: [] });
  }

  const mutualUserIds = mutualUsers.map(u => u.userId);

  // Distinct familyIds from their public wants.
  const wantFamilyRows = await db
    .selectDistinct({ familyId: wantsItems.familyId })
    .from(wantsItems)
    .innerJoin(users, eq(users.id, wantsItems.userId))
    .where(and(
      inArray(wantsItems.userId, mutualUserIds),
      eq(users.wantsPublic, true),
    ));

  // Distinct productIds from their public available lists.
  const availableProductRows = await db
    .selectDistinct({ productId: availableItems.productId })
    .from(availableItems)
    .innerJoin(users, eq(users.id, availableItems.userId))
    .where(and(
      inArray(availableItems.userId, mutualUserIds),
      eq(users.availablePublic, true),
    ));

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    wantFamilyIds: wantFamilyRows.map(r => r.familyId),
    availableProductIds: availableProductRows.map(r => r.productId),
  });
}

// --- community members (directory) ------------------------------------------

/**
 * Per-user breakdown of community members the viewer can see: one
 * entry per user in a mutually-enrolled + appear-in-queries guild.
 * The CommunityView browses this to find trading partners. The
 * rollup endpoint (`handleCommunity`) is the aggregated counterpart
 * — it tells the viewer WHAT exists; this tells them WHO has it.
 *
 * Gating (symmetric — both sides consent to the "queries" surface):
 *   - Viewer: enrolled=true + appearInQueries=true in ≥1 guild with
 *     the bot installed. A viewer who doesn't want to be queryable
 *     themselves also can't query others.
 *   - Member: enrolled=true + appearInQueries=true in ≥1 of those
 *     same guilds.
 *   - Member: profileVisibility != 'private'. The directory links
 *     to /u/handle; dead links would confuse, so we drop private
 *     profiles from the listing even if they're query-visible.
 *   - Viewer's own row always excluded.
 *
 * Privacy layering inside each member entry:
 *   - `wantFamilyIds` populated only when member.wantsPublic=true.
 *   - `availableProductIds` populated only when member.availablePublic=true.
 *   - Totals are reported even when lists are private — the count
 *     "this user has N wants" isn't leakage of WHICH cards, and
 *     signals worth-approaching-them-off-platform. (We can gate
 *     these later if that turns out to be wrong.)
 *
 * Response payload grows linearly with guild size + list length; for
 * a 50-member guild where everyone has 100 wants the body is well
 * under 100KB. Client does overlap computation locally so we don't
 * need to look up familyId ↔ productId on the server.
 */
export interface CommunityMember {
  userId: string;
  handle: string;
  username: string;
  avatarUrl: string | null;
  mutualGuildNames: string[];
  wantsPublic: boolean;
  availablePublic: boolean;
  wantsTotal: number;
  availableTotal: number;
  wantFamilyIds: string[];
  availableProductIds: string[];
}

export async function handleCommunityMembers(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  const viewerGuilds = await db
    .select({ guildId: userGuildMemberships.guildId })
    .from(userGuildMemberships)
    .where(and(
      eq(userGuildMemberships.userId, session.userId),
      eq(userGuildMemberships.enrolled, true),
      eq(userGuildMemberships.appearInQueries, true),
    ));

  if (viewerGuilds.length === 0) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ members: [] });
  }

  const guildIds = viewerGuilds.map(g => g.guildId);

  // Candidate memberships in mutual guilds.
  const memberRows = await db
    .select({
      userId: userGuildMemberships.userId,
      guildId: userGuildMemberships.guildId,
      guildName: userGuildMemberships.guildName,
    })
    .from(userGuildMemberships)
    .where(and(
      inArray(userGuildMemberships.guildId, guildIds),
      eq(userGuildMemberships.enrolled, true),
      eq(userGuildMemberships.appearInQueries, true),
      ne(userGuildMemberships.userId, session.userId),
    ));

  if (memberRows.length === 0) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ members: [] });
  }

  const candidateUserIds = Array.from(new Set(memberRows.map(r => r.userId)));

  // User records — skip private profiles now so subsequent queries
  // don't bother fetching their wants/available.
  const userRows = await db
    .select({
      id: users.id,
      handle: users.handle,
      username: users.username,
      avatarUrl: users.avatarUrl,
      wantsPublic: users.wantsPublic,
      availablePublic: users.availablePublic,
      profileVisibility: users.profileVisibility,
    })
    .from(users)
    .where(inArray(users.id, candidateUserIds));

  const visibleUsers = userRows.filter(u => u.profileVisibility !== 'private');
  if (visibleUsers.length === 0) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ members: [] });
  }
  const visibleIds = visibleUsers.map(u => u.id);

  // Wants + available only for users whose lists are public, but
  // totals for everyone (cheap and useful without leaking contents).
  const wantsPublicIds = visibleUsers.filter(u => u.wantsPublic).map(u => u.id);
  const availablePublicIds = visibleUsers.filter(u => u.availablePublic).map(u => u.id);

  const wantsRows = wantsPublicIds.length > 0
    ? await db
        .select({ userId: wantsItems.userId, familyId: wantsItems.familyId })
        .from(wantsItems)
        .where(inArray(wantsItems.userId, wantsPublicIds))
    : [];

  const availableRows = availablePublicIds.length > 0
    ? await db
        .select({ userId: availableItems.userId, productId: availableItems.productId })
        .from(availableItems)
        .where(inArray(availableItems.userId, availablePublicIds))
    : [];

  // Totals — one count(*) grouped by user_id across everyone
  // visible, regardless of *_public. Used for "this user has N
  // wants" display even when the contents are hidden.
  const wantsTotals = await db
    .select({ userId: wantsItems.userId, familyId: wantsItems.familyId })
    .from(wantsItems)
    .where(inArray(wantsItems.userId, visibleIds));
  const availableTotals = await db
    .select({ userId: availableItems.userId, productId: availableItems.productId })
    .from(availableItems)
    .where(inArray(availableItems.userId, visibleIds));

  // Group everything by userId for shape assembly.
  const guildsByUser = new Map<string, string[]>();
  for (const m of memberRows) {
    const list = guildsByUser.get(m.userId) ?? [];
    if (!list.includes(m.guildName)) list.push(m.guildName);
    guildsByUser.set(m.userId, list);
  }

  const wantsByUser = new Map<string, Set<string>>();
  for (const w of wantsRows) {
    const s = wantsByUser.get(w.userId) ?? new Set();
    s.add(w.familyId);
    wantsByUser.set(w.userId, s);
  }
  const availByUser = new Map<string, Set<string>>();
  for (const a of availableRows) {
    const s = availByUser.get(a.userId) ?? new Set();
    s.add(a.productId);
    availByUser.set(a.userId, s);
  }

  const wantsTotalByUser = new Map<string, Set<string>>();
  for (const w of wantsTotals) {
    const s = wantsTotalByUser.get(w.userId) ?? new Set();
    s.add(w.familyId);
    wantsTotalByUser.set(w.userId, s);
  }
  const availTotalByUser = new Map<string, Set<string>>();
  for (const a of availableTotals) {
    const s = availTotalByUser.get(a.userId) ?? new Set();
    s.add(a.productId);
    availTotalByUser.set(a.userId, s);
  }

  const members: CommunityMember[] = visibleUsers.map(u => ({
    userId: u.id,
    handle: u.handle,
    username: u.username,
    avatarUrl: u.avatarUrl,
    mutualGuildNames: guildsByUser.get(u.id) ?? [],
    wantsPublic: u.wantsPublic,
    availablePublic: u.availablePublic,
    wantsTotal: wantsTotalByUser.get(u.id)?.size ?? 0,
    availableTotal: availTotalByUser.get(u.id)?.size ?? 0,
    wantFamilyIds: u.wantsPublic ? Array.from(wantsByUser.get(u.id) ?? []) : [],
    availableProductIds: u.availablePublic ? Array.from(availByUser.get(u.id) ?? []) : [],
  }));

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ members });
}
