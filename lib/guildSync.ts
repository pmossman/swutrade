import { and, eq, notInArray } from 'drizzle-orm';
import { getDb } from './db.js';
import { userGuildMemberships } from './schema.js';

/**
 * Discord's `GET /users/@me/guilds` response shape (subset we care
 * about). `permissions` is a stringified bitfield — we check for
 * MANAGE_GUILD (bit 5, 0x20) to gate the LGS-admin page in v2.
 */
interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
  permissions?: string;
}

const MANAGE_GUILD = 0x20n;

/**
 * Pulls the user's current Discord guild list using the OAuth access
 * token, then reconciles our `user_guild_memberships` table:
 *   - upserts rows for every guild returned (Discord reality wins
 *     for name/icon/permissions cache)
 *   - deletes rows for guilds the user has left since last sync
 *
 * Deliberately preserves per-guild consent fields (`enrolled`,
 * `includeInRollups`, `appearInQueries`) on upsert — a re-sync
 * shouldn't flip a user's opt-in state. Only the cached metadata and
 * `lastSeenAt` update.
 *
 * Failures are non-fatal: we log and return. Sign-in should proceed
 * with stale (or empty) guild data rather than block the user.
 */
export async function syncGuildMemberships(
  userId: string,
  accessToken: string,
): Promise<void> {
  let guilds: DiscordGuildSummary[];
  try {
    const res = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.error('syncGuildMemberships: Discord guilds fetch failed', res.status);
      return;
    }
    guilds = (await res.json()) as DiscordGuildSummary[];
  } catch (err) {
    console.error('syncGuildMemberships: fetch threw', err);
    return;
  }

  const db = getDb();
  const now = new Date();
  const guildIds = guilds.map(g => g.id);

  // Upsert every current guild. onConflictDoUpdate preserves consent
  // flags (enrolled / includeInRollups / appearInQueries) by omitting
  // them from the SET clause.
  for (const g of guilds) {
    const canManage = g.permissions ? (BigInt(g.permissions) & MANAGE_GUILD) !== 0n : false;
    await db
      .insert(userGuildMemberships)
      .values({
        id: `ugm-${userId}-${g.id}`,
        userId,
        guildId: g.id,
        guildName: g.name,
        guildIcon: g.icon,
        canManage,
        enrolled: false,
        includeInRollups: false,
        appearInQueries: false,
        joinedAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [userGuildMemberships.userId, userGuildMemberships.guildId],
        set: {
          guildName: g.name,
          guildIcon: g.icon,
          canManage,
          lastSeenAt: now,
        },
      });
  }

  // Prune: rows where the guild_id is NOT in the freshly fetched set.
  // If the user left every server, guildIds is [] and we'd drop all
  // their rows — that's correct behaviour, so no empty-list guard.
  if (guildIds.length > 0) {
    await db
      .delete(userGuildMemberships)
      .where(and(
        eq(userGuildMemberships.userId, userId),
        notInArray(userGuildMemberships.guildId, guildIds),
      ));
  } else {
    await db
      .delete(userGuildMemberships)
      .where(eq(userGuildMemberships.userId, userId));
  }
}
