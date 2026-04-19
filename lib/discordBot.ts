/**
 * Outbound helpers for the SWUTrade bot. Calls Discord's REST API
 * using the application's bot token (`DISCORD_BOT_TOKEN`).
 *
 * Every Discord write flows through one of these helpers so:
 *   - Tests can swap the fetch implementation via dependency
 *     injection (see discordClient.ts for the same pattern with
 *     the user OAuth surface).
 *   - Error handling + logging is consistent.
 *
 * Scope is deliberately narrow — only the endpoints we actually
 * call today. Every new method pairs with a captured fixture
 * under tests/fixtures/discord/. See PHASE4_TESTING.md.
 */

import { classifyDiscordError, DiscordRateLimitError } from './discordErrors.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  url?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
  thumbnail?: { url: string };
  image?: { url: string };
  author?: { name: string; icon_url?: string; url?: string };
}

export interface DiscordComponent {
  type: number;
  components?: DiscordComponent[];
  style?: number;
  label?: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface DiscordMessageBody {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordComponent[];
  allowed_mentions?: { parse?: Array<'users' | 'roles' | 'everyone'> };
}

export interface DiscordBotClient {
  postChannelMessage(channelId: string, body: DiscordMessageBody): Promise<{ id: string; channel_id: string }>;
  /** PATCH an existing bot-authored message in place. Used to swap
   *  the Accept/Decline button row for an outcome banner after a
   *  proposal is resolved, so the user can't re-click stale buttons. */
  editChannelMessage(channelId: string, messageId: string, body: DiscordMessageBody): Promise<void>;
  createDmChannel(userId: string): Promise<{ id: string }>;
  /** Shortcut: open a DM channel (if needed) and post to it. */
  sendDirectMessage(userId: string, body: DiscordMessageBody): Promise<{ id: string; channel_id: string }>;
  /** Look up basic guild metadata — used by the install webhook to
   *  cache guild_name / guild_icon without a second round-trip. */
  getGuild(guildId: string): Promise<{ id: string; name: string; icon: string | null }>;
  /** Create a private thread in the given parent channel. Used for the
   *  multi-user trade-conversation flow — both traders get added via
   *  `addThreadMember` and chat directly in the thread. `autoArchive`
   *  is minutes: 60, 1440 (1d), 4320 (3d), or 10080 (7d). */
  createPrivateThread(
    parentChannelId: string,
    opts: { name: string; autoArchive?: 60 | 1440 | 4320 | 10080 },
  ): Promise<{ id: string; parent_id: string }>;
  /** Add a user to a thread. Sends them a "X added you to a thread"
   *  system message + push notification. */
  addThreadMember(threadId: string, userId: string): Promise<void>;
  /** Delete a channel or thread. Used to clean up an orphan thread
   *  after `addThreadMember` fails (e.g. recipient isn't a real
   *  Discord user) — otherwise the parent channel accumulates empty
   *  threads with just the bot/proposer inside. */
  deleteChannel(channelId: string): Promise<void>;
  /** Create a new guild text channel. Returns the channel id. */
  createGuildChannel(
    guildId: string,
    opts: {
      name: string;
      type: 0; // GUILD_TEXT
      topic?: string;
      permission_overwrites?: Array<{
        id: string; // role or user id
        type: 0 | 1; // 0 = role, 1 = user
        allow?: string; // bitfield as string
        deny?: string;
      }>;
    },
  ): Promise<{ id: string; name: string }>;
  /** Fetch the bot's member row in a guild — we use this to resolve
   *  the bot's managed-integration role so we can grant it the right
   *  permission overwrites on a channel we just created.
   *
   *  `botUserId` must be the bot's Discord user id, which for bot
   *  applications is identical to the OAuth `DISCORD_CLIENT_ID`.
   *  Discord's `/members/@me` alias is explicitly rejected for bots
   *  (403 "Bots cannot use this endpoint"), which is why the caller
   *  supplies the id explicitly. */
  getGuildBotMember(
    guildId: string,
    botUserId: string,
  ): Promise<{
    roles: string[];
    user: { id: string };
  }>;
}

/**
 * Bot client config knobs — primarily exposed so tests can pin the
 * sleep function (no real setTimeout in unit tests) + disable the
 * auto-retry to exercise the 429 path cleanly.
 */
export interface CreateBotClientOptions {
  token?: string;
  apiBase?: string;
  /** Max automatic retries on 429. Default 1 — first retry waits
   *  `Retry-After` then surfaces if it also 429s. Set to 0 to
   *  disable retrying entirely. */
  maxRetries?: number;
  /** Cap the retry sleep so a malicious/buggy Discord response with
   *  `retry_after: 3600` doesn't hang a serverless function for an
   *  hour. Default 5s — Vercel's default function timeout is 10s
   *  for Hobby, so half of that is a sensible ceiling. */
  maxRetrySleepSeconds?: number;
  /** Injected sleep for tests. Defaults to setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected fetch — tests stub this to drive the retry behaviour
   *  deterministically. Defaults to the runtime's global fetch. */
  fetch?: typeof fetch;
}

export function createDiscordBotClient(opts: CreateBotClientOptions = {}): DiscordBotClient {
  const token = opts.token ?? process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN is not set — bot cannot make API calls');
  }
  const apiBase = opts.apiBase ?? DISCORD_API_BASE;
  const maxRetries = opts.maxRetries ?? 1;
  const maxRetrySleepSeconds = opts.maxRetrySleepSeconds ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  async function request(path: string, init: RequestInit): Promise<Response> {
    const method = init.method ?? 'GET';
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await fetchImpl(`${apiBase}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (res.ok) return res;

      const bodyText = await res.text().catch(() => '');
      const err = classifyDiscordError(res.status, method, path, bodyText, res.headers);

      // Auto-retry on 429 up to `maxRetries` times. We don't retry
      // 5xx because most bot writes (POST /messages, PATCH /members)
      // aren't idempotent and a blind retry can dupe.
      if (err instanceof DiscordRateLimitError && attempt < maxRetries) {
        attempt += 1;
        const sleepSeconds = Math.min(err.retryAfterSeconds, maxRetrySleepSeconds);
        await sleep(Math.max(0, sleepSeconds * 1000));
        continue;
      }
      throw err;
    }
  }

  return {
    async postChannelMessage(channelId, body) {
      const res = await request(`/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return res.json() as Promise<{ id: string; channel_id: string }>;
    },

    async editChannelMessage(channelId, messageId, body) {
      await request(`/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },

    async createDmChannel(userId) {
      const res = await request('/users/@me/channels', {
        method: 'POST',
        body: JSON.stringify({ recipient_id: userId }),
      });
      return res.json() as Promise<{ id: string }>;
    },

    async sendDirectMessage(userId, body) {
      const channel = await this.createDmChannel(userId);
      return this.postChannelMessage(channel.id, body);
    },

    async getGuild(guildId) {
      const res = await request(`/guilds/${guildId}`, { method: 'GET' });
      return res.json() as Promise<{ id: string; name: string; icon: string | null }>;
    },

    async createPrivateThread(parentChannelId, opts) {
      const res = await request(`/channels/${parentChannelId}/threads`, {
        method: 'POST',
        body: JSON.stringify({
          name: opts.name,
          // type 12 = PRIVATE_THREAD. Requires CREATE_PRIVATE_THREADS
          // on the parent channel. Invisible to members who aren't
          // explicitly added via addThreadMember.
          type: 12,
          auto_archive_duration: opts.autoArchive ?? 1440,
          invitable: false,
        }),
      });
      return res.json() as Promise<{ id: string; parent_id: string }>;
    },

    async addThreadMember(threadId, userId) {
      await request(`/channels/${threadId}/thread-members/${userId}`, {
        method: 'PUT',
      });
    },

    async deleteChannel(channelId) {
      await request(`/channels/${channelId}`, { method: 'DELETE' });
    },

    async createGuildChannel(guildId, opts) {
      const res = await request(`/guilds/${guildId}/channels`, {
        method: 'POST',
        body: JSON.stringify(opts),
      });
      return res.json() as Promise<{ id: string; name: string }>;
    },

    async getGuildBotMember(guildId, botUserId) {
      const res = await request(`/guilds/${guildId}/members/${botUserId}`, { method: 'GET' });
      return res.json() as Promise<{ roles: string[]; user: { id: string } }>;
    },
  };
}
