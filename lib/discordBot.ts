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

import { classifyDiscordError, DiscordRateLimitError, DiscordServerError } from './discordErrors.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * A real Discord snowflake is a 17–19 digit decimal string. Anything
 * else — `test-iso-…`, `api-…`, `e2e-sender-…`, `synth-dm-…` — is a
 * fixture id minted by our own test harness or a placeholder we
 * synthesised in a previous short-circuited call.
 *
 * Production users can't have non-snowflake discordIds because we set
 * `users.discord_id` from Discord's `/users/@me` payload at OAuth
 * callback time. So this gate only ever fires for synthetic data,
 * which means we can safely no-op the API call rather than waste a
 * round-trip (or, worse, generate misleading 503s when Discord's
 * edge is flaky).
 */
function isSyntheticDiscordId(id: string): boolean {
  return !/^\d{17,19}$/.test(id);
}

function syntheticId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

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

  /**
   * Wrapped fetch with retry policy.
   *
   * - 429: always retried up to `maxRetries`, sleeping for the
   *   header-supplied `Retry-After` (capped by `maxRetrySleepSeconds`).
   * - 5xx: retried only when the caller marks the request `idempotent`.
   *   The risk we're avoiding is a non-idempotent write (POST
   *   /messages) returning 503 *after* it already created the
   *   resource — a blind retry would dupe. Idempotent endpoints
   *   (GET, DELETE, `POST /users/@me/channels` which returns the
   *   existing DM, `PUT /thread-members`) don't have that risk.
   * - everything else: surfaced as the corresponding DiscordApiError
   *   subclass.
   */
  async function request(
    path: string,
    init: RequestInit,
    opts: { idempotent?: boolean } = {},
  ): Promise<Response> {
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

      if (err instanceof DiscordRateLimitError && attempt < maxRetries) {
        attempt += 1;
        const sleepSeconds = Math.min(err.retryAfterSeconds, maxRetrySleepSeconds);
        await sleep(Math.max(0, sleepSeconds * 1000));
        continue;
      }

      if (opts.idempotent && err instanceof DiscordServerError && attempt < maxRetries) {
        attempt += 1;
        // Linear backoff capped at maxRetrySleepSeconds. 5xx blips
        // are usually edge-proxy hiccups that clear in <1s; we don't
        // need exponential here.
        const sleepMs = Math.min(500 * attempt, maxRetrySleepSeconds * 1000);
        await sleep(sleepMs);
        continue;
      }
      throw err;
    }
  }

  return {
    async postChannelMessage(channelId, body) {
      if (isSyntheticDiscordId(channelId)) {
        return { id: syntheticId('synth-msg'), channel_id: channelId };
      }
      const res = await request(`/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return res.json() as Promise<{ id: string; channel_id: string }>;
    },

    async editChannelMessage(channelId, messageId, body) {
      if (isSyntheticDiscordId(channelId) || isSyntheticDiscordId(messageId)) return;
      await request(`/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },

    async createDmChannel(userId) {
      if (isSyntheticDiscordId(userId)) {
        return { id: `synth-dm-${userId}` };
      }
      // POST /users/@me/channels is idempotent — Discord returns the
      // existing DM channel for a (bot, user) pair rather than
      // creating duplicates. Safe to retry on 5xx.
      const res = await request('/users/@me/channels', {
        method: 'POST',
        body: JSON.stringify({ recipient_id: userId }),
      }, { idempotent: true });
      return res.json() as Promise<{ id: string }>;
    },

    async sendDirectMessage(userId, body) {
      const channel = await this.createDmChannel(userId);
      return this.postChannelMessage(channel.id, body);
    },

    async getGuild(guildId) {
      if (isSyntheticDiscordId(guildId)) {
        return { id: guildId, name: 'Synthetic Guild', icon: null };
      }
      const res = await request(`/guilds/${guildId}`, { method: 'GET' }, { idempotent: true });
      return res.json() as Promise<{ id: string; name: string; icon: string | null }>;
    },

    async createPrivateThread(parentChannelId, opts) {
      if (isSyntheticDiscordId(parentChannelId)) {
        return { id: syntheticId('synth-thread'), parent_id: parentChannelId };
      }
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
      if (isSyntheticDiscordId(threadId) || isSyntheticDiscordId(userId)) return;
      // PUT — idempotent. Adding a user already in the thread is a
      // 204 no-op, so retrying on 5xx can't double-add.
      await request(`/channels/${threadId}/thread-members/${userId}`, {
        method: 'PUT',
      }, { idempotent: true });
    },

    async deleteChannel(channelId) {
      if (isSyntheticDiscordId(channelId)) return;
      await request(`/channels/${channelId}`, { method: 'DELETE' }, { idempotent: true });
    },

    async createGuildChannel(guildId, opts) {
      if (isSyntheticDiscordId(guildId)) {
        return { id: syntheticId('synth-channel'), name: opts.name };
      }
      const res = await request(`/guilds/${guildId}/channels`, {
        method: 'POST',
        body: JSON.stringify(opts),
      });
      return res.json() as Promise<{ id: string; name: string }>;
    },

    async getGuildBotMember(guildId, botUserId) {
      if (isSyntheticDiscordId(guildId)) {
        return { roles: [], user: { id: botUserId } };
      }
      const res = await request(
        `/guilds/${guildId}/members/${botUserId}`,
        { method: 'GET' },
        { idempotent: true },
      );
      return res.json() as Promise<{ roles: string[]; user: { id: string } }>;
    },
  };
}
