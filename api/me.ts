import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, count, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { users, userGuildMemberships, userPeerPrefs, botInstalledGuilds, wantsItems, availableItems, tradeProposals } from '../lib/schema.js';
import { requireSession, getDiscordAccessToken } from '../lib/auth.js';
import { syncGuildMemberships } from '../lib/guildSync.js';
import { createDiscordClient, type DiscordClient } from '../lib/discordClient.js';
import {
  PREF_DEFINITIONS,
  getPrefDefinition,
  validatePrefValue,
} from '../lib/prefsRegistry.js';
import { resolvePref } from '../lib/prefsResolver.js';
import {
  recordEvent as recordCommunityEvent,
  listEvents as listCommunityEvents,
} from '../lib/communityEvents.js';

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
    case 'community-activity':
      return handleCommunityActivity(req, res);
    case 'recent-partners':
      return handleRecentPartners(req, res);
    default:
      return res.status(404).json({ error: 'Unknown /api/me action' });
  }
}

// --- prefs ------------------------------------------------------------------

/**
 * Registry-driven GET + PUT for every pref the app knows about —
 * both self-scoped and peer-scoped. `/api/me/prefs` and the legacy
 * `/api/me/settings` alias route here.
 *
 * Self scope (no `?peer=` / `peerUserId`):
 *   GET  → `{ [selfKey]: value, ... }` projected off users.
 *   PUT  → partial patch `{ [key]: value, ... }` against users.
 *          Unknown keys fail the whole request.
 *
 * Peer scope (GET `?peer=<id>`, PUT body includes `peerUserId`):
 *   GET  → `{ override: { [key]: value | null }, effective: { [key]: value } }`
 *          `override` = what's stored in user_peer_prefs (null when
 *          no row / null column — treated identically by the cascade).
 *          `effective` = what `resolvePref` would return, so the UI
 *          can render "inherit (currently: X)" without a second call.
 *   PUT  → `{ peerUserId, key, value }` where `value: null` clears
 *          the override. Only peer-scoped registered keys accepted.
 */
export async function handlePrefs(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  const peerId = typeof req.query.peer === 'string' ? req.query.peer : undefined;

  if (req.method === 'GET') {
    if (peerId) return handlePrefsPeerGet(req, res, session.userId, peerId);
    return handlePrefsSelfGet(res, session.userId);
  }

  if (req.method === 'PUT') {
    if (typeof req.body !== 'object' || req.body == null || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid body' });
    }
    const body = req.body as Record<string, unknown>;
    if (typeof body.peerUserId === 'string') {
      return handlePrefsPeerPut(res, session.userId, body);
    }
    return handlePrefsSelfPut(res, session.userId, body);
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handlePrefsSelfGet(res: VercelResponse, userId: string) {
  const db = getDb();
  const selfDefs = PREF_DEFINITIONS.filter(d => d.scope.kind === 'self');
  const usersCols = users as unknown as Record<string, import('drizzle-orm/pg-core').AnyPgColumn>;
  const projection: Record<string, import('drizzle-orm/pg-core').AnyPgColumn> = {};
  for (const def of selfDefs) {
    projection[def.key] = usersCols[def.column];
  }
  const [row] = await db
    .select(projection)
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(row);
}

async function handlePrefsSelfPut(
  res: VercelResponse,
  userId: string,
  patch: Record<string, unknown>,
) {
  const db = getDb();
  const keys = Object.keys(patch);
  if (keys.length === 0) return res.status(400).json({ error: 'Empty patch' });

  const updates: Record<string, boolean | string> = {};
  for (const key of keys) {
    const def = getPrefDefinition(key, 'self');
    if (!def) return res.status(400).json({ error: 'Unknown pref', key });
    const v = validatePrefValue(def, patch[key]);
    if (!v.ok) return res.status(400).json({ error: 'Invalid value', key, reason: v.reason });
    updates[def.column] = v.value;
  }
  await db
    .update(users)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return res.json({ ok: true });
}

async function handlePrefsPeerGet(
  _req: VercelRequest,
  res: VercelResponse,
  userId: string,
  peerUserId: string,
) {
  const db = getDb();
  const peerDefs = PREF_DEFINITIONS.filter(d => d.scope.kind === 'peer');
  const peerCols = userPeerPrefs as unknown as Record<string, import('drizzle-orm/pg-core').AnyPgColumn>;

  // Fetch the single peer-prefs row if it exists; project every
  // registered peer-scoped column.
  const projection: Record<string, import('drizzle-orm/pg-core').AnyPgColumn> = {};
  for (const def of peerDefs) {
    projection[def.key] = peerCols[def.column];
  }
  const [overrideRow] = Object.keys(projection).length > 0
    ? await db
        .select(projection)
        .from(userPeerPrefs)
        .where(and(
          eq(userPeerPrefs.userId, userId),
          eq(userPeerPrefs.peerUserId, peerUserId),
        ))
        .limit(1)
    : [undefined];

  const override: Record<string, boolean | string | null> = {};
  const effective: Record<string, boolean | string | null> = {};
  for (const def of peerDefs) {
    const stored = overrideRow ? overrideRow[def.key] : null;
    override[def.key] = (stored ?? null) as boolean | string | null;
    // Resolve separately so the client gets both the raw override and
    // the value the cascade would produce (for "inherit (currently X)").
    effective[def.key] = (await resolvePref({
      key: def.key,
      viewerUserId: userId,
      peerUserId,
    })) as boolean | string | null;
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ override, effective });
}

async function handlePrefsPeerPut(
  res: VercelResponse,
  userId: string,
  body: Record<string, unknown>,
) {
  const db = getDb();
  const peerUserId = body.peerUserId as string;
  const key = typeof body.key === 'string' ? body.key : '';
  const value = body.value;

  if (!key) return res.status(400).json({ error: 'Missing key' });
  if (peerUserId === userId) {
    return res.status(400).json({ error: "Can't override prefs against yourself" });
  }

  const def = getPrefDefinition(key, 'peer');
  if (!def) return res.status(400).json({ error: 'Unknown peer pref', key });

  // Null = clear override (fall back to self default). Any other
  // value goes through the validator.
  let persisted: boolean | string | null;
  if (value === null) {
    persisted = null;
  } else {
    const v = validatePrefValue(def, value);
    if (!v.ok) return res.status(400).json({ error: 'Invalid value', key, reason: v.reason });
    persisted = v.value;
  }

  // Upsert on (userId, peerUserId). Keep the row even when every
  // column is nulled — simpler than delete-when-all-null, and a
  // future peer-scoped column can land in the same row.
  const now = new Date();
  await db
    .insert(userPeerPrefs)
    .values({
      userId,
      peerUserId,
      [def.column]: persisted,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userPeerPrefs.userId, userPeerPrefs.peerUserId],
      set: { [def.column]: persisted, updatedAt: now },
    });

  return res.json({ ok: true });
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

  // Counts how many SWUTrade users are enrolled in each of the
  // viewer's guilds — surfaces "N members" stats in the Home
  // Communities module + the Community 2.0 guild header. Only counts
  // enrolled rows (not all memberships) because "enrolled" is the
  // SWUTrade-side community view; a user who joined the Discord guild
  // but didn't opt into the SWUTrade community shouldn't inflate the
  // count. One aggregate query scoped to the viewer's guild ids.
  const guildIds = memberships.map(m => m.guildId);
  const countRows = guildIds.length === 0 ? [] : await db
    .select({
      guildId: userGuildMemberships.guildId,
      count: count(),
    })
    .from(userGuildMemberships)
    .where(and(
      inArray(userGuildMemberships.guildId, guildIds),
      eq(userGuildMemberships.enrolled, true),
    ))
    .groupBy(userGuildMemberships.guildId);
  const memberCountByGuild = new Map(countRows.map(r => [r.guildId, Number(r.count)]));

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
      memberCount: memberCountByGuild.get(m.guildId) ?? 0,
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

  // Community feed: one `member_joined` per first-enrollment. The
  // enrollment patch is the explicit consent moment, so it's the
  // semantic analog of "joined the community." Subsequent toggles
  // (enrolled off, then back on) are deliberately NOT re-logged —
  // feed noise reduction.
  if (patch.enrolled === true && membership.enrolled === false) {
    await recordCommunityEvent(db, {
      guildId,
      actorUserId: session.userId,
      type: 'member_joined',
    });
  }

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
  /** Parallel array to mutualGuildNames — the Discord guild ids so
   *  the Settings page's Servers → Members sub-route can filter the
   *  directory to one specific guild without a new endpoint. */
  mutualGuildIds: string[];
  wantsPublic: boolean;
  availablePublic: boolean;
  wantsTotal: number;
  availableTotal: number;
  wantFamilyIds: string[];
  availableProductIds: string[];
  /** Registry-driven peer-scoped prefs the viewer has toward this
   *  specific member, plus the value the cascade would resolve to
   *  (override → viewer self → registry default). Keys are pref
   *  registry keys that have a scope=peer registration. Today only
   *  `communicationPref` is peer-scoped; adding a second peer pref
   *  flows through without a shape change on the client. */
  peerPrefs: {
    override: Record<string, boolean | string | null>;
    effective: Record<string, boolean | string | null>;
  };
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
  const guildIdsByUser = new Map<string, string[]>();
  for (const m of memberRows) {
    const names = guildsByUser.get(m.userId) ?? [];
    if (!names.includes(m.guildName)) names.push(m.guildName);
    guildsByUser.set(m.userId, names);
    const ids = guildIdsByUser.get(m.userId) ?? [];
    if (!ids.includes(m.guildId)) ids.push(m.guildId);
    guildIdsByUser.set(m.userId, ids);
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

  // Peer-scoped registry defs drive the `peerPrefs` field on each
  // member. Two queries total — one for viewer's self values
  // (cascade fallback), one for the viewer's override rows keyed by
  // peer user id. No N+1.
  const peerDefs = PREF_DEFINITIONS.filter(d => d.scope.kind === 'peer');
  const usersCols = users as unknown as Record<string, import('drizzle-orm/pg-core').AnyPgColumn>;
  const peerCols = userPeerPrefs as unknown as Record<string, import('drizzle-orm/pg-core').AnyPgColumn>;

  let viewerSelf: Record<string, boolean | string | null> = {};
  if (peerDefs.length > 0) {
    const selfProj: Record<string, import('drizzle-orm/pg-core').AnyPgColumn> = {};
    for (const def of peerDefs) selfProj[def.key] = usersCols[def.column];
    const [viewerRow] = await db
      .select(selfProj)
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    viewerSelf = (viewerRow ?? {}) as Record<string, boolean | string | null>;
  }

  const overrideByPeer = new Map<string, Record<string, boolean | string | null>>();
  if (peerDefs.length > 0 && visibleIds.length > 0) {
    const overrideProj: Record<string, import('drizzle-orm/pg-core').AnyPgColumn> = {
      peerUserId: userPeerPrefs.peerUserId,
    };
    for (const def of peerDefs) overrideProj[def.key] = peerCols[def.column];
    const overrideRows = await db
      .select(overrideProj)
      .from(userPeerPrefs)
      .where(and(
        eq(userPeerPrefs.userId, session.userId),
        inArray(userPeerPrefs.peerUserId, visibleIds),
      ));
    for (const row of overrideRows) {
      const peerId = row.peerUserId as string;
      const entry: Record<string, boolean | string | null> = {};
      for (const def of peerDefs) {
        entry[def.key] = (row[def.key] ?? null) as boolean | string | null;
      }
      overrideByPeer.set(peerId, entry);
    }
  }

  const members: CommunityMember[] = visibleUsers.map(u => {
    const override: Record<string, boolean | string | null> = {};
    const effective: Record<string, boolean | string | null> = {};
    const overrideRow = overrideByPeer.get(u.id) ?? {};
    for (const def of peerDefs) {
      const stored = overrideRow[def.key] ?? null;
      override[def.key] = stored;
      // Cascade resolved inline: override → viewer self value → self
      // def's registry default. Mirrors `resolvePref` without the
      // N+1 DB reads we'd incur if we called it per member.
      const selfValue = viewerSelf[def.key];
      const selfDef = getPrefDefinition(def.key, 'self');
      effective[def.key] = stored ?? selfValue ?? selfDef?.default ?? null;
    }
    return {
      userId: u.id,
      handle: u.handle,
      username: u.username,
      avatarUrl: u.avatarUrl,
      mutualGuildNames: guildsByUser.get(u.id) ?? [],
      mutualGuildIds: guildIdsByUser.get(u.id) ?? [],
      wantsPublic: u.wantsPublic,
      availablePublic: u.availablePublic,
      wantsTotal: wantsTotalByUser.get(u.id)?.size ?? 0,
      availableTotal: availTotalByUser.get(u.id)?.size ?? 0,
      wantFamilyIds: u.wantsPublic ? Array.from(wantsByUser.get(u.id) ?? []) : [],
      availableProductIds: u.availablePublic ? Array.from(availByUser.get(u.id) ?? []) : [],
      peerPrefs: { override, effective },
    };
  });

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ members });
}

// --- community activity feed -----------------------------------------------

/**
 * Recent guild-scoped lifecycle events for the Community Overview tab.
 *
 * Query: `?guildId=<id>&limit=<n>` (guildId required; limit defaults to
 * 20, clamped server-side). Access gate mirrors the directory/members
 * surfaces — the viewer must be enrolled + appearInQueries in the
 * guild. Non-enrolled viewers get a 403 rather than an empty array so
 * the client doesn't silently render an empty feed for wall-hit users.
 *
 * Actor privacy (`users.share_activity_publicly=false`) is enforced
 * inside `communityEvents.listEvents`, not here.
 */
export async function handleCommunityActivity(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const guildId = typeof req.query.guildId === 'string' ? req.query.guildId : '';
  if (!guildId) {
    return res.status(400).json({ error: 'guildId is required' });
  }

  const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
  const limit = Number.isFinite(rawLimit) ? rawLimit : 20;

  const db = getDb();

  const [viewerMembership] = await db
    .select({ id: userGuildMemberships.id })
    .from(userGuildMemberships)
    .where(and(
      eq(userGuildMemberships.userId, session.userId),
      eq(userGuildMemberships.guildId, guildId),
      eq(userGuildMemberships.enrolled, true),
      eq(userGuildMemberships.appearInQueries, true),
    ))
    .limit(1);
  if (!viewerMembership) {
    return res.status(403).json({ error: 'Not enrolled in this guild' });
  }

  const events = await listCommunityEvents(db, guildId, { limit });

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ events });
}

// --- recent trade partners -------------------------------------------------

/**
 * Up to 5 distinct counterparties the viewer has recently interacted
 * with through a trade proposal — whether they proposed it or received
 * it. Powers the "Recent" chips row in HandlePickerDialog.
 *
 * Ordering: most-recent proposal interaction first (by `updated_at`).
 * Status is ignored — we surface partners from cancelled/declined
 * proposals too, since the intent ("you've traded through this
 * person's inbox before") is what the chip row signals.
 *
 * Shape: `{ partners: [{ userId, handle, username, avatarUrl, lastInteractionAt }] }`.
 * Private-profile users are included — the dialog just needs a handle
 * to navigate to; the profile gate applies when they try to load the
 * profile page, not when sending them a proposal.
 */
export async function handleRecentPartners(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();

  // Pull each proposal where the viewer is either side, sorted most
  // recent first. Over-fetch (50) so that after dedupe-by-counterpart
  // we still have enough rows to hit the 5-partner target even when
  // the same pair has several recent proposals.
  const rows = await db
    .select({
      proposerUserId: tradeProposals.proposerUserId,
      recipientUserId: tradeProposals.recipientUserId,
      updatedAt: tradeProposals.updatedAt,
    })
    .from(tradeProposals)
    .where(or(
      eq(tradeProposals.proposerUserId, session.userId),
      eq(tradeProposals.recipientUserId, session.userId),
    ))
    .orderBy(desc(tradeProposals.updatedAt))
    .limit(50);

  const partnerOrder: string[] = [];
  const lastSeen = new Map<string, Date>();
  for (const r of rows) {
    const counterpartId = r.proposerUserId === session.userId
      ? r.recipientUserId
      : r.proposerUserId;
    if (counterpartId === session.userId) continue;
    if (!lastSeen.has(counterpartId)) {
      partnerOrder.push(counterpartId);
      lastSeen.set(counterpartId, r.updatedAt);
    }
    if (partnerOrder.length >= 5) break;
  }

  if (partnerOrder.length === 0) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ partners: [] });
  }

  const userRows = await db
    .select({
      id: users.id,
      handle: users.handle,
      username: users.username,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, partnerOrder));

  const byId = new Map(userRows.map(u => [u.id, u]));
  const partners = partnerOrder
    .map(id => {
      const u = byId.get(id);
      if (!u) return null;
      return {
        userId: u.id,
        handle: u.handle,
        username: u.username,
        avatarUrl: u.avatarUrl,
        lastInteractionAt: lastSeen.get(id)?.toISOString() ?? null,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ partners });
}
