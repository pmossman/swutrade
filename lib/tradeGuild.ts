/**
 * Guild-installation utilities for the SWUTrade bot. Centralises:
 *   - `ensureSwutradeCategory`: idempotent provisioner for the bot's
 *     four-channel category in a guild (used by the install flow and
 *     by `api/signals.ts` when posting into a partially-installed guild).
 *   - `ensureTradesChannel`: backwards-compatible thin wrapper.
 *
 * Earlier this module also drove the proposal-thread routing (where to
 * host a trade's private thread for a given pair). That flow was retired
 * with the proposal system in Phase C — sessions are now the only trade
 * primitive, and they don't need per-pair guild routing.
 */

import { eq } from 'drizzle-orm';
import { botInstalledGuilds } from './schema.js';
import type { Db } from './db.js';

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
  modifyChannel?: (channelId: string, opts: { parent_id?: string | null }) => Promise<{ id: string }>;
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
  const categoryWasJustCreated = !row?.categoryId;
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

  // Re-parent helper: when we just minted a new category but the row
  // already carried a child channel id from the pre-category install,
  // the existing channel sits orphaned outside the new category.
  // Modify it in-place so it slots under the new category alongside
  // its siblings. Falls through silently if the bot client lacks
  // modifyChannel (synthetic test fakes) or the API call fails (e.g.
  // channel deleted manually) — the worst case is the orphaned
  // channel stays orphaned, which is the pre-fix status quo.
  async function reparentExisting(existingId: string): Promise<void> {
    if (!categoryWasJustCreated) return;
    if (!bot.modifyChannel) return;
    try {
      await bot.modifyChannel(existingId, { parent_id: categoryId });
    } catch (err) {
      console.error('ensureSwutradeCategory: re-parent failed', { existingId, err });
    }
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
  } else {
    await reparentExisting(tradesChannelId);
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
  } else {
    await reparentExisting(postsChannelId);
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
  } else {
    await reparentExisting(announcementsChannelId);
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
  } else {
    await reparentExisting(discussionChannelId);
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
