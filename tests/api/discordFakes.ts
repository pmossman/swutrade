import type { DiscordBotClient, DiscordMessageBody } from '../../lib/discordBot.js';

/**
 * Shared fake DiscordBotClient helpers for the tests/api/*.test.ts
 * suites. Before this file, seven test files each defined their own
 * `makeFakeBot()` — each slightly different, each a fan-out risk when
 * the DiscordBotClient interface grew (e.g. when private threads
 * landed, each local variant had to add the new methods).
 *
 * Use `createBaseFakeBot(overrides)` — it returns a full
 * DiscordBotClient with every method defaulted to a throwing
 * "unused in this test" stub. Each test spreads its own recorders /
 * failing methods via `overrides`. If a test accidentally triggers a
 * method it didn't opt into, the helpful error string tells you
 * which method + fires as a test failure instead of silently
 * returning undefined.
 */

type FakeBotOverrides = Partial<DiscordBotClient>;

export function createBaseFakeBot(overrides: FakeBotOverrides = {}): DiscordBotClient {
  const unused = (name: string) => {
    return (async () => {
      throw new Error(`makeFakeBot: ${name} was called but the test didn't configure it`);
    }) as unknown;
  };
  return {
    postChannelMessage: unused('postChannelMessage') as DiscordBotClient['postChannelMessage'],
    editChannelMessage: unused('editChannelMessage') as DiscordBotClient['editChannelMessage'],
    createDmChannel: unused('createDmChannel') as DiscordBotClient['createDmChannel'],
    sendDirectMessage: unused('sendDirectMessage') as DiscordBotClient['sendDirectMessage'],
    getGuild: unused('getGuild') as DiscordBotClient['getGuild'],
    createPrivateThread: unused('createPrivateThread') as DiscordBotClient['createPrivateThread'],
    addThreadMember: unused('addThreadMember') as DiscordBotClient['addThreadMember'],
    deleteChannel: unused('deleteChannel') as DiscordBotClient['deleteChannel'],
    createGuildChannel: unused('createGuildChannel') as DiscordBotClient['createGuildChannel'],
    getGuildBotMember: unused('getGuildBotMember') as DiscordBotClient['getGuildBotMember'],
    ...overrides,
  };
}

// Common recorder shapes — surfaced here so individual tests don't
// redeclare the same inline array types.
export type EditCall = { channelId: string; messageId: string; body: DiscordMessageBody };
export type SendCall = { userId: string; body: DiscordMessageBody };
export type PostCall = { channelId: string; body: DiscordMessageBody };

export interface RecordingFakeBot extends DiscordBotClient {
  sendCalls: SendCall[];
  editCalls: EditCall[];
  postCalls: PostCall[];
  /** userIds passed to createDmChannel in call order. */
  createDmCalls: string[];
}

export interface RecordingFakeBotOptions {
  /** When truthy, `sendDirectMessage` throws. Pass a string to override
   *  the error message. */
  sendFails?: boolean | string;
  /** When truthy, `editChannelMessage` throws. */
  editFails?: boolean | string;
  /** When truthy, `postChannelMessage` throws. */
  postFails?: boolean | string;
  /** Override the response returned from `sendDirectMessage`. */
  sendResponse?: { id: string; channel_id: string };
  /** Override the response returned from `postChannelMessage`. */
  postResponse?: { id: string; channel_id: string };
  /** Channel id returned from `createDmChannel`. */
  dmChannelId?: string;
}

/**
 * Higher-level fake bot that wires recorder arrays for the four
 * most-exercised methods + per-method failure / response overrides.
 * Covers the "simple recording bot" shape used across several
 * tests/api/*.test.ts files — saves each file from re-declaring the
 * same call-tracking scaffolding.
 *
 * For tests that need thread flows (`createPrivateThread` +
 * `addThreadMember`), guild-channel creation, bot-member queries,
 * id-sequencing across multiple sends, or similar specialised
 * simulation, build your own on top of `createBaseFakeBot()` with
 * domain-specific overrides. See `tests/api/trades-propose.test.ts`
 * and `tests/api/bot.test.ts` for examples.
 */
export function createRecordingFakeBot(
  opts: RecordingFakeBotOptions = {},
): RecordingFakeBot {
  const sendCalls: SendCall[] = [];
  const editCalls: EditCall[] = [];
  const postCalls: PostCall[] = [];
  const createDmCalls: string[] = [];

  const dmChannelId = opts.dmChannelId ?? 'dm-fake';

  const bot = createBaseFakeBot({
    async createDmChannel(userId: string) {
      createDmCalls.push(userId);
      return { id: dmChannelId };
    },
    async sendDirectMessage(userId, body) {
      sendCalls.push({ userId, body });
      if (opts.sendFails) {
        throw new Error(
          typeof opts.sendFails === 'string' ? opts.sendFails : 'simulated DM failure',
        );
      }
      return opts.sendResponse ?? { id: 'msg-fake', channel_id: dmChannelId };
    },
    async editChannelMessage(channelId, messageId, body) {
      editCalls.push({ channelId, messageId, body });
      if (opts.editFails) {
        throw new Error(
          typeof opts.editFails === 'string' ? opts.editFails : 'simulated edit failure',
        );
      }
    },
    async postChannelMessage(channelId, body) {
      postCalls.push({ channelId, body });
      if (opts.postFails) {
        throw new Error(
          typeof opts.postFails === 'string' ? opts.postFails : 'simulated post failure',
        );
      }
      // Default response echoes the called channelId — matches the real
      // Discord API (which returns the message in the channel it was
      // posted to) and is what most handlers assume. Override via
      // `postResponse` if a test needs a specific id; otherwise leave
      // the channel_id dynamic so the handler's follow-up edit path
      // addresses the right channel.
      if (opts.postResponse) return opts.postResponse;
      return { id: 'post-fake', channel_id: channelId };
    },
  });

  return Object.assign(bot, { sendCalls, editCalls, postCalls, createDmCalls });
}
