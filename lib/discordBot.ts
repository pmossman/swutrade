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

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  url?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
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
}

export function createDiscordBotClient(opts: { token?: string; apiBase?: string } = {}): DiscordBotClient {
  const token = opts.token ?? process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN is not set — bot cannot make API calls');
  }
  const apiBase = opts.apiBase ?? DISCORD_API_BASE;

  async function request(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '<no body>');
      throw new Error(`Discord bot API ${init.method ?? 'GET'} ${path} failed: ${res.status} ${detail}`);
    }
    return res;
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
  };
}
