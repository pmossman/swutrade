/**
 * E2E fixture helpers for Phase-4 guild scenarios. Mirror the
 * vitest-side helpers in tests/api/helpers.ts so specs can seed
 * enrollment state without running through Discord. Uses dynamic
 * imports for the same reason the existing auth helpers do — keeps
 * anonymous e2e tests from loading DB modules they don't need.
 */

export async function installBotInGuild(guildId: string, opts: {
  guildName?: string;
} = {}): Promise<() => Promise<void>> {
  const { getDb } = await import('../../lib/db.js');
  const { botInstalledGuilds } = await import('../../lib/schema.js');
  const { eq } = await import('drizzle-orm');

  const db = getDb();
  await db.insert(botInstalledGuilds).values({
    guildId,
    guildName: opts.guildName ?? `E2E Guild ${guildId}`,
    guildIcon: null,
  }).onConflictDoNothing();
  return async () => {
    await db.delete(botInstalledGuilds).where(eq(botInstalledGuilds.guildId, guildId)).catch(() => {});
  };
}

export async function createGuildMembership(userId: string, guildId: string, opts: {
  enrolled?: boolean;
  includeInRollups?: boolean;
  appearInQueries?: boolean;
  canManage?: boolean;
  guildName?: string;
} = {}): Promise<() => Promise<void>> {
  const { getDb } = await import('../../lib/db.js');
  const { userGuildMemberships } = await import('../../lib/schema.js');
  const { eq } = await import('drizzle-orm');

  const db = getDb();
  const enrolled = opts.enrolled ?? false;
  const id = `ugm-${userId}-${guildId}`;
  // Re-run the fixture on reruns — delete any leftover row first.
  await db.delete(userGuildMemberships).where(eq(userGuildMemberships.id, id)).catch(() => {});
  await db.insert(userGuildMemberships).values({
    id,
    userId,
    guildId,
    guildName: opts.guildName ?? `E2E Guild ${guildId}`,
    guildIcon: null,
    canManage: opts.canManage ?? false,
    enrolled,
    includeInRollups: opts.includeInRollups ?? enrolled,
    appearInQueries: opts.appearInQueries ?? enrolled,
  });
  return async () => {
    await db.delete(userGuildMemberships).where(eq(userGuildMemberships.id, id)).catch(() => {});
  };
}

export async function getGuildMembership(userId: string, guildId: string) {
  const { getDb } = await import('../../lib/db.js');
  const { userGuildMemberships } = await import('../../lib/schema.js');
  const { and, eq } = await import('drizzle-orm');
  const db = getDb();
  const [row] = await db
    .select()
    .from(userGuildMemberships)
    .where(and(
      eq(userGuildMemberships.userId, userId),
      eq(userGuildMemberships.guildId, guildId),
    ))
    .limit(1);
  return row ?? null;
}

export async function getUserSettings(userId: string) {
  const { getDb } = await import('../../lib/db.js');
  const { users } = await import('../../lib/schema.js');
  const { eq } = await import('drizzle-orm');
  const db = getDb();
  const [row] = await db
    .select({
      profileVisibility: users.profileVisibility,
      dmTradeProposals: users.dmTradeProposals,
      dmMatchAlerts: users.dmMatchAlerts,
      dmMeetupReminders: users.dmMeetupReminders,
      communicationPref: users.communicationPref,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}
