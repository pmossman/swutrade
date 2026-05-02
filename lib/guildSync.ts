import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { getDb } from './db.js';
import { userGuildMemberships, botInstalledGuilds } from './schema.js';
import { createDiscordClient, type DiscordClient } from './discordClient.js';

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
 *
 * Takes the DiscordClient as a parameter so tests can inject a fake
 * without stubbing global fetch. Production callers use the default.
 */
export async function syncGuildMemberships(
  userId: string,
  accessToken: string,
  discord: DiscordClient = createDiscordClient(),
  opts: { propagateDiscordErrors?: boolean } = {},
): Promise<void> {
  let guilds;
  try {
    guilds = await discord.getUserGuilds(accessToken);
  } catch (err) {
    // Default: swallow — this path runs at sign-in where we don't
    // want Discord's availability to block OAuth completion.
    // Callers that need to surface the error (e.g., the explicit
    // "Refresh servers" button) pass `propagateDiscordErrors: true`
    // so a 401/network failure reaches them.
    console.error('syncGuildMemberships: Discord fetch threw', err);
    if (opts.propagateDiscordErrors) throw err;
    return;
  }

  const db = getDb();
  const now = new Date();
  const guildIds = guilds.map(g => g.id);

  // Pre-fetch the set of guilds where SWUTrade's bot is installed.
  // New memberships in those guilds auto-enroll (enrolled + appear
  // in queries + include in rollups), so new users don't have to
  // dig through Settings to access the features the bot enables.
  // Existing memberships preserve the user's prior choice — beta
  // feedback was specifically "new users bounce off the opt-in
  // wall," not "override existing preferences."
  const botGuildRows = guildIds.length > 0
    ? await db
        .select({ guildId: botInstalledGuilds.guildId })
        .from(botInstalledGuilds)
        .where(inArray(botInstalledGuilds.guildId, guildIds))
    : [];
  const botInstalledIds = new Set(botGuildRows.map(r => r.guildId));

  // Upsert every current guild. onConflictDoUpdate preserves consent
  // flags (enrolled / includeInRollups / appearInQueries) by omitting
  // them from the SET clause.
  //
  // Run upserts in parallel — each row targets a distinct
  // (userId, guildId) pair, so order doesn't matter and they don't
  // contend. Sequential awaits here previously blocked OAuth
  // sign-in for ~1s per guild on the user. Audit 07-performance H3
  // + 04-auth #2.
  await Promise.all(guilds.map(g => {
    const canManage = g.permissions ? (BigInt(g.permissions) & MANAGE_GUILD) !== 0n : false;
    const autoEnroll = botInstalledIds.has(g.id);
    return db
      .insert(userGuildMemberships)
      .values({
        id: `ugm-${userId}-${g.id}`,
        userId,
        guildId: g.id,
        guildName: g.name,
        guildIcon: g.icon,
        canManage,
        enrolled: autoEnroll,
        includeInRollups: autoEnroll,
        appearInQueries: autoEnroll,
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
  }));

  // Prune: rows where the guild_id is NOT in the freshly fetched set.
  // If the user left every server, guildIds is [] and we'd drop all
  // their rows — that's correct behaviour.
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
