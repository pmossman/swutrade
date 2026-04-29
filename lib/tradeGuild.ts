/**
 * Pick the guild that hosts a trade's private thread.
 *
 * For a (proposer, recipient) pair, we look at the intersection of:
 *   - guilds the proposer is in   (`user_guild_memberships`)
 *   - guilds the recipient is in  (`user_guild_memberships`)
 *   - guilds the bot is installed in with a non-null trades channel
 *     (`bot_installed_guilds`)
 *
 * Among the candidates, the default winner is chosen by a cascade
 * (most-stable signal first):
 *
 *   1. The guild where this pair has most-recently transacted —
 *      `max(trade_proposals.created_at)` for any prior proposal
 *      whose guild_id is set and matches the candidate. Stickiness:
 *      after a pair trades once in guild X, future trades default
 *      back there until something changes.
 *   2. The guild whose bot install is most recent
 *      (`bot_installed_guilds.installed_at`). Newer installs are
 *      where active community lives.
 *   3. Lexicographic `guild_id` — deterministic last-resort tiebreaker.
 *
 * Callers can override the default by passing `preferredGuildId`;
 * we still validate that all three sets contain it (so an
 * out-of-band id can't smuggle a thread into a guild the bot isn't
 * even in).
 *
 * Returns null when no candidate guild qualifies — caller falls
 * back to DM-only delivery.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  botInstalledGuilds,
  tradeProposals,
  userGuildMemberships,
} from './schema.js';
import type { Db } from './db.js';

export interface ResolvedTradeGuild {
  guildId: string;
  guildName: string;
  guildIcon: string | null;
  tradesChannelId: string;
}

export interface MutualBotGuild extends ResolvedTradeGuild {
  isDefault: boolean;
}

/**
 * Pull every guild that qualifies as a host for a trade between
 * `proposerUserId` and `recipientUserId`. Sorted in default-pick
 * order; first element is the default. Empty array means DM-only.
 */
export async function listMutualBotGuilds(
  db: Db,
  proposerUserId: string,
  recipientUserId: string,
): Promise<MutualBotGuild[]> {
  // Set-intersection in SQL: proposer's guilds INNER JOIN recipient's
  // guilds INNER JOIN bot_installed_guilds (with a real trades
  // channel). One round-trip — the candidate set is small (most users
  // share a handful of guilds at most).
  const candidates = await db
    .select({
      guildId: botInstalledGuilds.guildId,
      guildName: botInstalledGuilds.guildName,
      guildIcon: botInstalledGuilds.guildIcon,
      tradesChannelId: botInstalledGuilds.tradesChannelId,
      installedAt: botInstalledGuilds.installedAt,
    })
    .from(botInstalledGuilds)
    .innerJoin(
      userGuildMemberships,
      and(
        eq(userGuildMemberships.guildId, botInstalledGuilds.guildId),
        eq(userGuildMemberships.userId, proposerUserId),
      ),
    )
    .where(
      and(
        sql`${botInstalledGuilds.tradesChannelId} IS NOT NULL`,
        // Recipient must also have a membership row for this guild.
        // EXISTS subquery rather than a second join so the proposer
        // join stays narrow and the planner doesn't have to undup.
        sql`EXISTS (
          SELECT 1 FROM ${userGuildMemberships} m2
          WHERE m2.user_id = ${recipientUserId}
            AND m2.guild_id = ${botInstalledGuilds.guildId}
        )`,
      ),
    );

  if (candidates.length === 0) return [];

  // Pull the most-recent trade-together timestamp per candidate guild
  // for the "this pair has traded here before" tiebreaker. Empty when
  // they've never traded (the common case before the feature lands);
  // the cascade falls through cleanly.
  const guildIds = candidates.map(c => c.guildId);
  const lastTradedRows = await db
    .select({
      guildId: tradeProposals.guildId,
      lastAt: sql<Date>`max(${tradeProposals.createdAt})`.as('last_at'),
    })
    .from(tradeProposals)
    .where(
      and(
        inArray(tradeProposals.guildId, guildIds),
        sql`(
          (${tradeProposals.proposerUserId} = ${proposerUserId} AND ${tradeProposals.recipientUserId} = ${recipientUserId})
          OR
          (${tradeProposals.proposerUserId} = ${recipientUserId} AND ${tradeProposals.recipientUserId} = ${proposerUserId})
        )`,
      ),
    )
    .groupBy(tradeProposals.guildId);

  const lastTradedAt = new Map<string, number>();
  for (const row of lastTradedRows) {
    if (row.guildId && row.lastAt) {
      lastTradedAt.set(row.guildId, new Date(row.lastAt).getTime());
    }
  }

  // Apply the cascade. Higher score wins; ties fall to the next
  // criterion. JavaScript sort is stable so the lexicographic
  // last-resort uses guildId order naturally.
  candidates.sort((a, b) => {
    const lastA = lastTradedAt.get(a.guildId) ?? 0;
    const lastB = lastTradedAt.get(b.guildId) ?? 0;
    if (lastA !== lastB) return lastB - lastA;            // most recent trade first
    const installedDiff = b.installedAt.getTime() - a.installedAt.getTime();
    if (installedDiff !== 0) return installedDiff;         // newer install first
    return a.guildId < b.guildId ? -1 : 1;                 // lexicographic
  });

  return candidates.map((c, idx) => ({
    guildId: c.guildId,
    guildName: c.guildName,
    guildIcon: c.guildIcon,
    // Non-null asserted: the WHERE clause filters rows where
    // tradesChannelId IS NOT NULL, so the column is guaranteed
    // populated for everything we return.
    tradesChannelId: c.tradesChannelId!,
    isDefault: idx === 0,
  }));
}

/**
 * Resolve a single guild for a proposal. Returns the requested guild
 * if the caller passed `preferredGuildId` and it qualifies; otherwise
 * the cascade-chosen default. Null means "no qualifying guild — fall
 * back to DM."
 */
export async function resolveTradeGuild(
  db: Db,
  proposerUserId: string,
  recipientUserId: string,
  preferredGuildId: string | null = null,
): Promise<ResolvedTradeGuild | null> {
  const candidates = await listMutualBotGuilds(db, proposerUserId, recipientUserId);
  if (candidates.length === 0) return null;

  if (preferredGuildId) {
    const match = candidates.find(c => c.guildId === preferredGuildId);
    if (match) {
      const { isDefault: _isDefault, ...rest } = match;
      return rest;
    }
    // The caller asked for a specific guild but it doesn't qualify
    // (user not a member, bot not installed, etc.). Fall through to
    // the default rather than 4xxing — the proposer's cached UI may
    // be stale, and silently degrading to a working guild is better
    // than failing the send.
  }

  const { isDefault: _isDefault, ...rest } = candidates[0];
  return rest;
}

/**
 * Look up the trades channel for a guild we already know is valid
 * (e.g. read off `trade_proposals.guild_id` for a counter or button
 * interaction). Returns null if the guild was uninstalled in the
 * meantime — caller falls back to DM.
 */
export async function getGuildTradesChannel(
  db: Db,
  guildId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ tradesChannelId: botInstalledGuilds.tradesChannelId })
    .from(botInstalledGuilds)
    .where(eq(botInstalledGuilds.guildId, guildId))
    .limit(1);
  return row?.tradesChannelId ?? null;
}

/**
 * Auto-create the `#swutrade-threads` channel for a guild and stash
 * its id on `bot_installed_guilds.trades_channel_id`. Used by:
 *
 *   - the bot install handler on first install (welcome path), and
 *   - the signals API when a post lands on a guild whose install
 *     pre-dates the auto-create logic OR whose first attempt failed
 *     (bot DM'd the install admin but the channel didn't get created
 *     because of permissions / race / outage).
 *
 * Idempotent on the DB row but not on Discord — a successful run
 * persists the new channel id; a failed call leaves the row's
 * `trades_channel_id` unchanged. Bubbles errors so callers can
 * decide whether to surface a fix-it message.
 */
export async function ensureTradesChannel(
  db: Db,
  guildId: string,
  bot: {
    getGuildBotMember: (guildId: string, botUserId: string) => Promise<{ roles: string[] }>;
    createGuildChannel: (guildId: string, body: Record<string, unknown>) => Promise<{ id: string }>;
  },
): Promise<string> {
  const botUserId = process.env.DISCORD_CLIENT_ID;
  if (!botUserId) {
    throw new Error('DISCORD_CLIENT_ID not set — cannot resolve bot member');
  }
  const botMember = await bot.getGuildBotMember(guildId, botUserId);
  const botRoleId = botMember.roles[0];
  if (!botRoleId) {
    throw new Error('bot has no roles in guild — cannot grant channel perms');
  }
  // The `@everyone` role id in Discord always equals the guild id.
  const everyoneRoleId = guildId;
  const channel = await bot.createGuildChannel(guildId, {
    name: 'swutrade-threads',
    type: 0,
    topic:
      'SWUTrade · trade proposal threads + signal posts land here. Move signals to a dedicated channel via SWUTrade settings.',
    permission_overwrites: [
      {
        id: everyoneRoleId,
        type: 0,
        // VIEW_CHANNEL so members can see the channel. Private threads
        // are invisible regardless of channel-level defaults.
        allow: '1024',
      },
      {
        id: botRoleId,
        type: 0,
        // Full set from BOT_INSTALL_PERMISSIONS so the bot works
        // regardless of server defaults on the channel.
        allow: '360777255952',
      },
    ],
  });
  await db
    .update(botInstalledGuilds)
    .set({ tradesChannelId: channel.id })
    .where(eq(botInstalledGuilds.guildId, guildId));
  return channel.id;
}
