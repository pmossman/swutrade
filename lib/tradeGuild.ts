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
 * Bitfield literals for the channel-create permission overlays we
 * apply. Discord encodes permission bitsets as decimal strings;
 * pre-summing makes the call sites readable. Values cross-checked
 * against https://discord.com/developers/docs/topics/permissions.
 */
const PERM_VIEW_CHANNEL = 0x400n;          // 1024
const PERM_SEND_MESSAGES = 0x800n;         // 2048
const PERM_READ_MESSAGE_HISTORY = 0x10000n; // 65536
const PERM_ADD_REACTIONS = 0x40n;          // 64
const PERM_EMBED_LINKS = 0x4000n;          // 16384
const PERM_ATTACH_FILES = 0x8000n;         // 32768

const EVERYONE_VIEW_ONLY = (PERM_VIEW_CHANNEL).toString();
const EVERYONE_VIEW_AND_REACT = (PERM_VIEW_CHANNEL | PERM_READ_MESSAGE_HISTORY | PERM_ADD_REACTIONS).toString();
const EVERYONE_FULL_CHAT = (
  PERM_VIEW_CHANNEL | PERM_READ_MESSAGE_HISTORY | PERM_ADD_REACTIONS
  | PERM_SEND_MESSAGES | PERM_EMBED_LINKS | PERM_ATTACH_FILES
).toString();
/** Same bitset the bot install asked for — keeps the bot working
 *  in each channel regardless of server defaults. */
const BOT_FULL_PERMS = '360777255952';

interface SwutradeChannelIds {
  categoryId: string;
  tradesChannelId: string;
  postsChannelId: string;
  announcementsChannelId: string;
  discussionChannelId: string;
}

interface ChannelEnsureBot {
  getGuildBotMember: (guildId: string, botUserId: string) => Promise<{ roles: string[] }>;
  createGuildChannel: (guildId: string, body: Record<string, unknown>) => Promise<{ id: string; name: string }>;
  postChannelMessage?: (channelId: string, body: Record<string, unknown>) => Promise<{ id: string }>;
}

/**
 * Provision the SWUTrade channel category + four standard channels
 * for a guild and stash their ids on `bot_installed_guilds`. Used
 * by the install flow (welcome path) and by api/signals.ts when a
 * post lands on a guild whose install pre-dates the category model
 * OR whose first attempt partially failed.
 *
 * Layout:
 *   📁 SWUTrade
 *      #swutrade-posts          (members can reply; signals land here)
 *      #swutrade-threads        (private trade-proposal threads parent)
 *      #swutrade-announcements  (read-only; SWUTrade-team broadcasts)
 *      #swutrade-discussion     (open community chat about the app)
 *
 * Idempotent at the per-piece level: if the row already has any of
 * the channel ids set, we keep them. Only missing pieces get
 * created. Lets re-running the function repair partial installs
 * without duplicating channels.
 *
 * Returns the resolved ids for every piece so the caller can use
 * them directly without a re-read.
 */
export async function ensureSwutradeCategory(
  db: Db,
  guildId: string,
  bot: ChannelEnsureBot,
): Promise<SwutradeChannelIds> {
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

  const [row] = await db
    .select({
      categoryId: botInstalledGuilds.categoryId,
      tradesChannelId: botInstalledGuilds.tradesChannelId,
      postsChannelId: botInstalledGuilds.postsChannelId,
      announcementsChannelId: botInstalledGuilds.announcementsChannelId,
      discussionChannelId: botInstalledGuilds.discussionChannelId,
    })
    .from(botInstalledGuilds)
    .where(eq(botInstalledGuilds.guildId, guildId))
    .limit(1);

  // 1. Category — non-chat container that groups the four channels.
  //    Carries the bot's full permission set so child channels inherit
  //    it; admins can override per-channel later.
  let categoryId = row?.categoryId ?? null;
  if (!categoryId) {
    const cat = await bot.createGuildChannel(guildId, {
      name: 'SWUTrade',
      type: 4,
      permission_overwrites: [
        { id: botRoleId, type: 0, allow: BOT_FULL_PERMS },
      ],
    });
    categoryId = cat.id;
  }

  // 2. #swutrade-threads — private trade-proposal threads parent.
  //    @everyone can VIEW only; private threads themselves are
  //    invisible to non-participants regardless of channel perms.
  let tradesChannelId = row?.tradesChannelId ?? null;
  if (!tradesChannelId) {
    const ch = await bot.createGuildChannel(guildId, {
      name: 'swutrade-threads',
      type: 0,
      parent_id: categoryId,
      topic: 'SWUTrade · trade-proposal threads. The bot creates a private thread per proposal; only the traders see the contents.',
      permission_overwrites: [
        { id: everyoneRoleId, type: 0, allow: EVERYONE_VIEW_ONLY },
        { id: botRoleId, type: 0, allow: BOT_FULL_PERMS },
      ],
    });
    tradesChannelId = ch.id;
  }

  // 3. #swutrade-posts — signal posts (Looking-for / Offering).
  //    Members can reply inline so a post can become a quick
  //    conversation thread without spawning a Discord thread.
  let postsChannelId = row?.postsChannelId ?? null;
  if (!postsChannelId) {
    const ch = await bot.createGuildChannel(guildId, {
      name: 'swutrade-posts',
      type: 0,
      parent_id: categoryId,
      topic: 'SWUTrade · signal posts. Looking-for + Offering boards from your community. Reply on a post to coordinate.',
      permission_overwrites: [
        { id: everyoneRoleId, type: 0, allow: EVERYONE_FULL_CHAT },
        { id: botRoleId, type: 0, allow: BOT_FULL_PERMS },
      ],
    });
    postsChannelId = ch.id;
  }

  // 4. #swutrade-announcements — read-only broadcast channel.
  //    @everyone can view + react but not send; the bot posts.
  let announcementsChannelId = row?.announcementsChannelId ?? null;
  let announcementsJustCreated = false;
  if (!announcementsChannelId) {
    const ch = await bot.createGuildChannel(guildId, {
      name: 'swutrade-announcements',
      type: 0,
      parent_id: categoryId,
      topic: 'SWUTrade · roadmap milestones, weekly community summaries, feature changelogs.',
      permission_overwrites: [
        { id: everyoneRoleId, type: 0, allow: EVERYONE_VIEW_AND_REACT },
        { id: botRoleId, type: 0, allow: BOT_FULL_PERMS },
      ],
    });
    announcementsChannelId = ch.id;
    announcementsJustCreated = true;
  }

  // 5. #swutrade-discussion — open community chat about the app.
  //    Self-sustaining surface; we don't post here automatically.
  let discussionChannelId = row?.discussionChannelId ?? null;
  if (!discussionChannelId) {
    const ch = await bot.createGuildChannel(guildId, {
      name: 'swutrade-discussion',
      type: 0,
      parent_id: categoryId,
      topic: 'SWUTrade · feedback, questions, and chat about the app itself. Trade-talk lives in #swutrade-posts.',
      permission_overwrites: [
        { id: everyoneRoleId, type: 0, allow: EVERYONE_FULL_CHAT },
        { id: botRoleId, type: 0, allow: BOT_FULL_PERMS },
      ],
    });
    discussionChannelId = ch.id;
  }

  await db
    .update(botInstalledGuilds)
    .set({
      categoryId,
      tradesChannelId,
      postsChannelId,
      announcementsChannelId,
      discussionChannelId,
    })
    .where(eq(botInstalledGuilds.guildId, guildId));

  // Seed announcements with a welcome post on first creation so the
  // channel reads as deliberately quiet rather than abandoned. Best-
  // effort — failure here doesn't roll back the channels.
  if (announcementsJustCreated && bot.postChannelMessage) {
    try {
      await bot.postChannelMessage(announcementsChannelId, {
        embeds: [{
          title: '👋 Welcome to SWUTrade in this server',
          description: [
            'Updates from the SWUTrade team will land here:',
            '',
            '• Roadmap milestones & changelogs',
            '• Weekly community summaries (top wishlisted cards, trades made, new members)',
            '• New-feature announcements',
            '',
            'Got feedback or questions? Drop them in <#' + discussionChannelId + '>.',
            'Want to start trading? Compose a post at swutrade.com.',
          ].join('\n'),
          color: 0xF5A623,
        }],
      });
    } catch (err) {
      console.error('ensureSwutradeCategory: announcements welcome post failed', err);
    }
  }

  return { categoryId, tradesChannelId, postsChannelId, announcementsChannelId, discussionChannelId };
}

/** Backwards-compatible shim — old callers still in the repo (or
 *  any forks) can keep using the `ensureTradesChannel` name; it
 *  forwards to the category-aware ensure flow and returns just the
 *  trades-channel id for the existing return contract. */
export async function ensureTradesChannel(
  db: Db,
  guildId: string,
  bot: ChannelEnsureBot,
): Promise<string> {
  const ids = await ensureSwutradeCategory(db, guildId, bot);
  return ids.tradesChannelId;
}
