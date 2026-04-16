import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../lib/db.js';
import { users } from '../../lib/schema.js';
import { requireSession } from '../../lib/auth.js';

/**
 * Account-level settings (profile visibility + bot-DM consent flags).
 * GET returns current state; PUT merges partial updates. Per-guild
 * toggles live in /api/me/guilds/[guildId]/settings (separate surface
 * so the audit trail + validation is per-guild).
 */

const SettingsPatchSchema = z.object({
  profileVisibility: z.enum(['public', 'discord', 'private']).optional(),
  dmTradeProposals: z.boolean().optional(),
  dmMatchAlerts: z.boolean().optional(),
  dmMeetupReminders: z.boolean().optional(),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

/** Exported for the per-guild settings endpoint to reuse the gate. */
export { SettingsPatchSchema };
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
