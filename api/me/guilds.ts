import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { getDb } from '../../lib/db.js';
import { userGuildMemberships, botInstalledGuilds } from '../../lib/schema.js';
import { requireSession } from '../../lib/auth.js';

/**
 * Returns the signed-in user's Discord guilds grouped by whether
 * SWUTrade's bot is installed there (= "enrollable" community) or
 * not (= informational, with optional invite CTA).
 *
 * Callers are the settings + enrollment UIs.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
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
