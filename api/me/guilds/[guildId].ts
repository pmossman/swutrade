import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../lib/db.js';
import { userGuildMemberships, botInstalledGuilds } from '../../../lib/schema.js';
import { requireSession } from '../../../lib/auth.js';

/**
 * Per-guild Phase-4 consent toggles. PUT only — GET-all lives at
 * /api/me/guilds so the UI renders the list with one round-trip.
 *
 * Enrolling ties a handful of defaults to the "yes, I want to
 * participate in this community" bundle:
 *   enrolled=true → includeInRollups + appearInQueries default to
 *   true. User can individually toggle them off after the fact.
 * Disenrolling flips enrolled=false AND clears the bundle so a
 * later re-enrollment starts clean.
 *
 * Only allows changes on guilds where SWUTrade's bot is installed —
 * flipping flags on an uninstalled guild would silently no-op on
 * every downstream feature.
 */

const GuildPatchSchema = z.object({
  enrolled: z.boolean().optional(),
  includeInRollups: z.boolean().optional(),
  appearInQueries: z.boolean().optional(),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  // Gate: guild must be in bot_installed_guilds AND the user must be
  // a member. Anything else is a no-op (could also 404 — errs on the
  // side of being loud so client bugs surface).
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

  // Derive the final flag values: start from the existing row, apply
  // the patch, then if enrollment flipped to false also clear the
  // dependent bundle so re-enrollment is a clean default.
  const patch = parsed.data;
  const next = {
    enrolled: patch.enrolled ?? membership.enrolled,
    includeInRollups: patch.includeInRollups ?? membership.includeInRollups,
    appearInQueries: patch.appearInQueries ?? membership.appearInQueries,
  };
  if (patch.enrolled === true && membership.enrolled === false) {
    // Fresh enrollment: bundle on by default unless user also flipped
    // one off in the same request.
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
