import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { users, userGuildMemberships, botInstalledGuilds } from '../lib/schema.js';
import { requireSession } from '../lib/auth.js';

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
    case 'settings':
      return handleSettings(req, res);
    case 'guilds':
      return handleGuildsList(req, res);
    case 'guild':
      return handleGuildPut(req, res);
    default:
      return res.status(404).json({ error: 'Unknown /api/me action' });
  }
}

// --- settings ---------------------------------------------------------------

const SettingsPatchSchema = z.object({
  profileVisibility: z.enum(['public', 'discord', 'private']).optional(),
  dmTradeProposals: z.boolean().optional(),
  dmMatchAlerts: z.boolean().optional(),
  dmMeetupReminders: z.boolean().optional(),
});

export async function handleSettings(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const db = getDb();

  if (req.method === 'GET') {
    const [row] = await db
      .select({
        profileVisibility: users.profileVisibility,
        dmTradeProposals: users.dmTradeProposals,
        dmMatchAlerts: users.dmMatchAlerts,
        dmMeetupReminders: users.dmMeetupReminders,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(row);
  }

  if (req.method === 'PUT') {
    const parsed = SettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() });
    }
    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Empty patch' });
    }
    await db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, session.userId));
    return res.json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}

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
