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
