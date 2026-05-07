import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  mockRequest,
  mockResponse,
  createTestUser,
} from './helpers.js';
import handler, { dispatchBotPayload, resolveTestPublicKey } from '../../api/bot.js';
import { getDb } from '../../lib/db.js';
import { botInstalledGuilds, userGuildMemberships, users } from '../../lib/schema.js';
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type SendCall } from './discordFakes.js';

function extractRawEd25519PublicKey(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(12).toString('hex');
}

interface CreateChannelCall {
  guildId: string;
  opts: Parameters<DiscordBotClient['createGuildChannel']>[1];
}

interface FakeBotOptions {
  createGuildChannel?: (
    guildId: string,
    opts: Parameters<DiscordBotClient['createGuildChannel']>[1],
  ) => Promise<{ id: string; name: string }>;
  getGuildBotMember?: (
    guildId: string,
    botUserId: string,
  ) => Promise<{ roles: string[]; user: { id: string } }>;
}

interface GetGuildBotMemberCall {
  guildId: string;
  botUserId: string;
}

function makeFakeBot(options: FakeBotOptions = {}): DiscordBotClient & {
  sendCalls: SendCall[];
  createChannelCalls: CreateChannelCall[];
  getGuildBotMemberCalls: GetGuildBotMemberCall[];
} {
  const sendCalls: SendCall[] = [];
  const createChannelCalls: CreateChannelCall[] = [];
  const getGuildBotMemberCalls: GetGuildBotMemberCall[] = [];
  return Object.assign(
    createBaseFakeBot({
      // editChannelMessage stays a no-op so any incidental call doesn't
      // fail. The fakes are shared across the whole bot test suite.
      async editChannelMessage() { /* unused in current handlers */ },
      async createDmChannel() { return { id: 'dm-fake' }; },
      async sendDirectMessage(userId, body) {
        sendCalls.push({ userId, body });
        return { id: 'notify-msg-1', channel_id: 'dm-fake' };
      },
      async createGuildChannel(guildId, opts) {
        createChannelCalls.push({ guildId, opts });
        if (options.createGuildChannel) return options.createGuildChannel(guildId, opts);
        return { id: `channel-${guildId}`, name: opts.name };
      },
      async getGuildBotMember(guildId, botUserId) {
        getGuildBotMemberCalls.push({ guildId, botUserId });
        if (options.getGuildBotMember) return options.getGuildBotMember(guildId, botUserId);
        return { roles: ['bot-role-1'], user: { id: botUserId } };
      },
    }),
    {
      sendCalls,
      createChannelCalls,
      getGuildBotMemberCalls,
    },
  );
}

describe('resolveTestPublicKey', () => {
  const TEST_KEY = 'deadbeef'.repeat(8);

  it('returns the test key on non-production envs (preview, dev, undefined)', () => {
    expect(resolveTestPublicKey({ VERCEL_ENV: 'preview', DISCORD_APP_PUBLIC_KEY_TEST: TEST_KEY })).toBe(TEST_KEY);
    expect(resolveTestPublicKey({ VERCEL_ENV: 'development', DISCORD_APP_PUBLIC_KEY_TEST: TEST_KEY })).toBe(TEST_KEY);
    expect(resolveTestPublicKey({ DISCORD_APP_PUBLIC_KEY_TEST: TEST_KEY })).toBe(TEST_KEY);
  });

  it('is inert when VERCEL_ENV=production, even if the env var is set (defence against a leaked test key)', () => {
    expect(resolveTestPublicKey({ VERCEL_ENV: 'production', DISCORD_APP_PUBLIC_KEY_TEST: TEST_KEY })).toBeUndefined();
  });

  it('returns undefined when the env var is unset', () => {
    expect(resolveTestPublicKey({ VERCEL_ENV: 'preview' })).toBeUndefined();
  });
});

describeWithDb('/api/bot dispatcher', () => {
  const cleanupGuildIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of cleanupGuildIds) {
      await db.delete(botInstalledGuilds).where(eq(botInstalledGuilds.guildId, id)).catch(() => {});
    }
    cleanupGuildIds.length = 0;
  });

  describe('interactions', () => {
    it('replies to a PING with a PONG (the handshake Discord requires before accepting the endpoint URL)', async () => {
      const res = mockResponse();
      await dispatchBotPayload('interactions', { type: 1 }, res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ type: 1 });
    });

    it('acks unknown interaction types with DEFERRED_UPDATE_MESSAGE (6) so Discord doesn\'t show a generic failure', async () => {
      const res = mockResponse();
      await dispatchBotPayload('interactions', { type: 999 }, res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ type: 6 });
    });


    describe('prefs buttons (registry-driven)', () => {
      // Post-hygiene-pass, the registry has only boolean prefs that
      // surface on Discord. Enum prefs (profileVisibility) are web-
      // only, so the boolean flow is the entire test surface. Pick
      // dmSessionActivity (default true) as a representative.
      it('pref:dmSessionActivity:open returns On/Off buttons for a boolean pref, current highlighted', async () => {
        const user = await createTestUser();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'pref:dmSessionActivity:open' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as {
          type: number;
          data?: { components?: Array<{ components?: Array<{ style?: number; label?: string; custom_id?: string }> }> };
        };
        const buttons = body.data?.components?.[0]?.components ?? [];
        expect(buttons.map(b => b.label)).toEqual(['On', 'Off']);
        expect(buttons.map(b => b.custom_id)).toEqual([
          'pref:dmSessionActivity:set:true',
          'pref:dmSessionActivity:set:false',
        ]);
        // Default true → On highlighted (style 3), Off secondary (2).
        expect(buttons[0].style).toBe(3);
        expect(buttons[1].style).toBe(2);

        await user.cleanup();
      });

      it('pref:dmSessionActivity:set:false updates the boolean column + returns UPDATE_MESSAGE', async () => {
        const user = await createTestUser();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'pref:dmSessionActivity:set:false' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(7);

        const db = getDb();
        const [row] = await db
          .select({ dmSessionActivity: users.dmSessionActivity })
          .from(users)
          .where(eq(users.discordId, user.id))
          .limit(1);
        expect(row.dmSessionActivity).toBe(false);

        await user.cleanup();
      });

      it('pref:profileVisibility:open defers — profileVisibility is web-only in the registry, not Discord-surfaced', async () => {
        const user = await createTestUser();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'pref:profileVisibility:open' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(6);

        await user.cleanup();
      });

      it('pref:{unknown-key}:open defers — no registered def', async () => {
        const user = await createTestUser();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'pref:notAPref:open' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(6);

        await user.cleanup();
      });

      it('pref:dmSessionActivity:set:bogus defers + no DB write', async () => {
        const user = await createTestUser();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'pref:dmSessionActivity:set:bogus' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(6);

        const db = getDb();
        const [row] = await db
          .select({ dmSessionActivity: users.dmSessionActivity })
          .from(users)
          .where(eq(users.discordId, user.id))
          .limit(1);
        // Default still applies (true) — bogus value rejected.
        expect(row.dmSessionActivity).toBe(true);

        await user.cleanup();
      });
    });



    describe('application commands (/swutrade settings + user context menu)', () => {
      // Application commands ACK with type-5 (deferred ephemeral)
      // immediately and PATCH the actual content via Discord's
      // webhook endpoint. Tests inject `fetchImpl` to capture the
      // PATCH and assert on its body. `awaitFollowup: true` lets
      // the test observe the followup synchronously instead of via
      // Vercel's `waitUntil` background path.
      function captureFollowup() {
        const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
        const fetchImpl: typeof fetch = (input, init) => {
          calls.push({
            url: typeof input === 'string' ? input : (input as URL).toString(),
            body: JSON.parse(String(init?.body ?? '{}')),
          });
          return Promise.resolve(new Response('', { status: 200 }));
        };
        return { calls, fetchImpl };
      }

      const APP_ID = 'app-test-1';
      const TOKEN = 'tok-test-1';

      it('slash /swutrade settings (no user) defers and follows up with self-prefs index ephemeral', async () => {
        const user = await createTestUser();
        const res = mockResponse();
        const { calls, fetchImpl } = captureFollowup();
        await dispatchBotPayload(
          'interactions',
          {
            type: 2, // APPLICATION_COMMAND
            application_id: APP_ID,
            token: TOKEN,
            data: {
              type: 1, // CHAT_INPUT
              name: 'swutrade',
              options: [
                {
                  type: 1, // SUB_COMMAND
                  name: 'settings',
                  options: [],
                },
              ],
            },
            user: { id: user.id },
          },
          res,
          { fetchImpl, awaitFollowup: true },
        );

        // Synchronous response is the deferred ack.
        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(5);

        // Followup PATCHed @original with the self-prefs body.
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toMatch(new RegExp(`/webhooks/${APP_ID}/${TOKEN}/messages/@original$`));
        const followup = calls[0].body as {
          flags?: number;
          components?: Array<{ components?: Array<{ custom_id?: string }> }>;
        };
        expect(followup.flags).toBe(64);
        const buttons = followup.components?.[0]?.components ?? [];
        const customIds = buttons.map(b => b.custom_id ?? '');
        // Index surfaces every Discord-surfaced self-pref as a
        // "<key>:open" button. Pick one we know survives the prefs
        // hygiene pass (registered in lib/prefsRegistry.ts).
        expect(customIds.some(c => c === 'pref:dmSessionInvited:open')).toBe(true);
        expect(customIds.every(c => c.startsWith('pref:') && c.endsWith(':open'))).toBe(true);

        await user.cleanup();
      });

      it('slash /swutrade settings user:@peer follows up with the empty-peer-prefs message (peer scope retired)', async () => {
        const viewer = await createTestUser();
        const peer = await createTestUser();

        const res = mockResponse();
        const { calls, fetchImpl } = captureFollowup();
        await dispatchBotPayload(
          'interactions',
          {
            type: 2,
            application_id: APP_ID,
            token: TOKEN,
            data: {
              type: 1,
              name: 'swutrade',
              options: [
                {
                  type: 1,
                  name: 'settings',
                  options: [
                    { type: 6, name: 'user', value: peer.id },
                  ],
                },
              ],
              resolved: {
                users: {
                  [peer.id]: { id: peer.id, username: peer.handle },
                },
              },
            },
            user: { id: viewer.id },
          },
          res,
          { fetchImpl, awaitFollowup: true },
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(5);

        expect(calls).toHaveLength(1);
        const followup = calls[0].body as {
          flags?: number;
          content?: string;
          components?: unknown[];
        };
        expect(followup.flags).toBe(64);
        expect(followup.content).toMatch(/No per-trader preferences are available/i);
        // No buttons: the peer surface ships the empty-state copy
        // only after the prefs hygiene pass dropped communicationPref.
        expect(followup.components ?? []).toEqual([]);

        await viewer.cleanup();
        await peer.cleanup();
      });

      it('slash with an unknown Discord id follows up with a helpful "not on SWUTrade" message', async () => {
        const viewer = await createTestUser();

        const res = mockResponse();
        const { calls, fetchImpl } = captureFollowup();
        await dispatchBotPayload(
          'interactions',
          {
            type: 2,
            application_id: APP_ID,
            token: TOKEN,
            data: {
              type: 1,
              name: 'swutrade',
              options: [
                {
                  type: 1,
                  name: 'settings',
                  options: [
                    { type: 6, name: 'user', value: 'nonexistent-discord-id-999999' },
                  ],
                },
              ],
            },
            user: { id: viewer.id },
          },
          res,
          { fetchImpl, awaitFollowup: true },
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(5);
        expect(calls).toHaveLength(1);
        expect((calls[0].body as { content?: string }).content).toMatch(/isn't on SWUTrade yet/i);

        await viewer.cleanup();
      });

      it('user context menu (type 2 command) follows up with the same empty-peer-prefs message', async () => {
        const viewer = await createTestUser();
        const peer = await createTestUser();

        const res = mockResponse();
        const { calls, fetchImpl } = captureFollowup();
        await dispatchBotPayload(
          'interactions',
          {
            type: 2,
            application_id: APP_ID,
            token: TOKEN,
            data: {
              type: 2, // USER context menu
              name: 'SWUTrade prefs',
              target_id: peer.id,
              resolved: {
                users: {
                  [peer.id]: { id: peer.id, username: peer.handle },
                },
              },
            },
            user: { id: viewer.id },
          },
          res,
          { fetchImpl, awaitFollowup: true },
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(5);
        expect(calls).toHaveLength(1);
        expect((calls[0].body as { content?: string }).content)
          .toMatch(/No per-trader preferences are available/i);

        await viewer.cleanup();
        await peer.cleanup();
      });

      // --- /swutrade trade @user (Phase B3) ----------------------------
      //
      // Both clicker and target must be SWUTrade users. On success
      // we create a session via createOrGetActiveSession, DM the
      // target through the same B1 helper (which respects the
      // dmSessionInvited pref), and the followup gives the clicker
      // an ephemeral message with the session URL.

      function tradeSlashPayload(opts: { clickerId: string; targetId: string; targetUsername?: string }) {
        return {
          type: 2,
          application_id: APP_ID,
          token: TOKEN,
          data: {
            type: 1,
            name: 'swutrade',
            options: [
              {
                type: 1, // SUB_COMMAND
                name: 'trade',
                options: [
                  { type: 6, name: 'user', value: opts.targetId },
                ],
              },
            ],
            resolved: opts.targetUsername
              ? { users: { [opts.targetId]: { id: opts.targetId, username: opts.targetUsername } } }
              : undefined,
          },
          user: { id: opts.clickerId },
        };
      }

      it('/swutrade trade @user — happy path: creates a session, DMs the target, followup links the URL', async () => {
        const alice = await createTestUser();
        const bob = await createTestUser();
        const bot = makeFakeBot();
        const res = mockResponse();
        const { calls, fetchImpl } = captureFollowup();

        await dispatchBotPayload(
          'interactions',
          tradeSlashPayload({ clickerId: alice.id, targetId: bob.id, targetUsername: bob.handle }),
          res,
          { bot, fetchImpl, awaitFollowup: true, origin: 'https://beta.swutrade.com' },
        );

        // Deferred ack first.
        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(5);

        // Followup carries the session URL.
        expect(calls).toHaveLength(1);
        const followup = calls[0].body as { content?: string; flags?: number };
        expect(followup.flags).toBe(64);
        expect(followup.content ?? '').toMatch(/Started a shared trade with @[\w-]+/);
        expect(followup.content ?? '').toMatch(/\/s\/[A-Z0-9]+/);

        // Bob got a DM via the B1 invite helper.
        expect(bot.sendCalls).toHaveLength(1);
        expect(bot.sendCalls[0].userId).toBe(bob.id);

        await alice.cleanup();
        await bob.cleanup();
      });

      it('/swutrade trade @user — idempotent on an existing active pair: no duplicate session, no second DM', async () => {
        const alice = await createTestUser();
        const bob = await createTestUser();
        const bot = makeFakeBot();
        const { fetchImpl: fetchImpl1 } = captureFollowup();

        await dispatchBotPayload(
          'interactions',
          tradeSlashPayload({ clickerId: alice.id, targetId: bob.id }),
          mockResponse(),
          { bot, fetchImpl: fetchImpl1, awaitFollowup: true },
        );
        expect(bot.sendCalls).toHaveLength(1);

        // Second invocation in the same active-pair window should
        // resolve to the SAME session and skip the DM (B1 only
        // fires on created:true).
        const { calls: calls2, fetchImpl: fetchImpl2 } = captureFollowup();
        await dispatchBotPayload(
          'interactions',
          tradeSlashPayload({ clickerId: alice.id, targetId: bob.id }),
          mockResponse(),
          { bot, fetchImpl: fetchImpl2, awaitFollowup: true },
        );

        // Followup uses the "already in flight" copy.
        const followup2 = calls2[0].body as { content?: string };
        expect(followup2.content ?? '').toMatch(/already have a shared trade in flight/i);
        // Still only one DM total — no duplicate ping for the same session.
        expect(bot.sendCalls).toHaveLength(1);

        await alice.cleanup();
        await bob.cleanup();
      });

      it('/swutrade trade @user — rejects self-trade with a friendly message, no DB write', async () => {
        const alice = await createTestUser();
        const bot = makeFakeBot();
        const { calls, fetchImpl } = captureFollowup();

        await dispatchBotPayload(
          'interactions',
          tradeSlashPayload({ clickerId: alice.id, targetId: alice.id }),
          mockResponse(),
          { bot, fetchImpl, awaitFollowup: true },
        );

        const followup = calls[0].body as { content?: string };
        expect(followup.content ?? '').toMatch(/can't start a trade with yourself/i);
        expect(bot.sendCalls).toHaveLength(0);

        await alice.cleanup();
      });

      it('/swutrade trade @user — target not on SWUTrade: returns sign-up CTA, no DM', async () => {
        const alice = await createTestUser();
        const bot = makeFakeBot();
        const { calls, fetchImpl } = captureFollowup();

        await dispatchBotPayload(
          'interactions',
          tradeSlashPayload({
            clickerId: alice.id,
            targetId: 'discord-id-not-on-swutrade',
            targetUsername: 'somebody',
          }),
          mockResponse(),
          { bot, fetchImpl, awaitFollowup: true },
        );

        const followup = calls[0].body as { content?: string };
        expect(followup.content ?? '').toMatch(/isn't on SWUTrade yet/i);
        expect(bot.sendCalls).toHaveLength(0);

        await alice.cleanup();
      });

      it('/swutrade trade @user — clicker not on SWUTrade: routes them to sign-in', async () => {
        const bob = await createTestUser();
        const bot = makeFakeBot();
        const { calls, fetchImpl } = captureFollowup();

        await dispatchBotPayload(
          'interactions',
          tradeSlashPayload({ clickerId: 'discord-id-not-on-swutrade', targetId: bob.id }),
          mockResponse(),
          { bot, fetchImpl, awaitFollowup: true },
        );

        const followup = calls[0].body as { content?: string };
        expect(followup.content ?? '').toMatch(/Sign in with Discord/i);
        expect(bot.sendCalls).toHaveLength(0);

        await bob.cleanup();
      });
    });

    // Legacy `comm-pref:*` custom_ids are retained during the
    // transition so in-flight DMs posted before the registry-driven
    // handler shipped keep working. Drop this block once deployed
    // DMs have had a release to roll over.
  });

  describe('events', () => {
    it('acks the event-webhook verification ping (type 0) with a 204', async () => {
      const res = mockResponse();
      await dispatchBotPayload('events', { type: 0 }, res);
      expect(res._status).toBe(204);
    });

    it('APPLICATION_AUTHORIZED writes a bot_installed_guilds row with cached metadata', async () => {
      const guildId = `e2e-authd-${Date.now()}`;
      cleanupGuildIds.push(guildId);

      // Pass a fake bot so the post-write auto-create path doesn't
      // hit real Discord. This test only asserts on the row metadata
      // — the auto-create behaviour itself has dedicated tests below.
      const bot = makeFakeBot();
      const res = mockResponse();
      await dispatchBotPayload('events', {
        type: 1,
        event: {
          type: 'APPLICATION_AUTHORIZED',
          data: {
            integration_type: 0,
            scopes: ['bot', 'applications.commands'],
            user: { id: 'installer-user', username: 'Installer' },
            guild: { id: guildId, name: 'Star Wars SD Test', icon: 'abc123' },
          },
        },
      }, res, { bot });

      expect(res._status).toBe(204);

      const db = getDb();
      const [row] = await db
        .select()
        .from(botInstalledGuilds)
        .where(eq(botInstalledGuilds.guildId, guildId))
        .limit(1);
      expect(row).toBeTruthy();
      expect(row.guildName).toBe('Star Wars SD Test');
      expect(row.guildIcon).toBe('abc123');
      expect(row.installedByUserId).toBe('installer-user');
    });

    it('APPLICATION_AUTHORIZED sends a welcome DM to the installing admin (fresh install only)', async () => {
      const guildId = `e2e-welcome-${Date.now()}`;
      cleanupGuildIds.push(guildId);

      const bot = makeFakeBot();
      const res = mockResponse();
      await dispatchBotPayload('events', {
        type: 1,
        event: {
          type: 'APPLICATION_AUTHORIZED',
          data: {
            integration_type: 0,
            scopes: ['bot', 'applications.commands'],
            user: { id: 'installer-parker', username: 'Parker' },
            guild: { id: guildId, name: 'My New Server', icon: null },
          },
        },
      }, res, { bot });

      expect(res._status).toBe(204);
      // Welcome DM fired to the installing admin with the guild name
      // and pointers to `/swutrade settings` + the web app.
      const dm = bot.sendCalls.find(c => c.userId === 'installer-parker');
      expect(dm, 'expected welcome DM to installer').toBeTruthy();
      const embed = dm?.body.embeds?.[0];
      expect(embed?.title).toContain('My New Server');
      const description = embed?.description ?? '';
      expect(description).toMatch(/swutrade settings/i);
      expect(description).toMatch(/beta\.swutrade\.com|swutrade\.com/);
    });

    it('APPLICATION_AUTHORIZED skips the welcome DM on a re-authorization (row already existed)', async () => {
      const guildId = `e2e-reinstall-welcome-${Date.now()}`;
      cleanupGuildIds.push(guildId);

      // Seed the row as if it already existed (prior install).
      const db = getDb();
      await db.insert(botInstalledGuilds).values({
        guildId,
        guildName: 'Previously Installed',
        guildIcon: null,
      });

      const bot = makeFakeBot();
      const res = mockResponse();
      await dispatchBotPayload('events', {
        type: 1,
        event: {
          type: 'APPLICATION_AUTHORIZED',
          data: {
            integration_type: 0,
            scopes: ['bot', 'applications.commands'],
            user: { id: 'installer-parker-reauth', username: 'Parker' },
            guild: { id: guildId, name: 'Previously Installed', icon: null },
          },
        },
      }, res, { bot });

      expect(res._status).toBe(204);
      // No welcome DM — the admin already got one when they first installed.
      const dm = bot.sendCalls.find(c => c.userId === 'installer-parker-reauth');
      expect(dm, 'expected NO welcome DM on re-auth').toBeUndefined();
    });

    it('APPLICATION_AUTHORIZED auto-creates the SWUTrade category + four channels and persists every id when the bot client succeeds', async () => {
      // Test-scoped env pin so the handler's DISCORD_CLIENT_ID lookup
      // has a value. CI doesn't write .env.local's DISCORD_CLIENT_ID
      // to the test process env; locally it's present via dotenv.
      const TEST_CLIENT_ID = 'test-client-id-autocreate';
      const prior = process.env.DISCORD_CLIENT_ID;
      process.env.DISCORD_CLIENT_ID = TEST_CLIENT_ID;
      const guildId = `e2e-autocreate-${Date.now()}`;
      cleanupGuildIds.push(guildId);
      const bot = makeFakeBot();
      const res = mockResponse();

      try {
        await dispatchBotPayload('events', {
          type: 1,
          event: {
            type: 'APPLICATION_AUTHORIZED',
            data: {
              integration_type: 0,
              scopes: ['bot', 'applications.commands'],
              user: { id: 'installer-user', username: 'Installer' },
              guild: { id: guildId, name: 'Auto Create Test', icon: null },
            },
          },
        }, res, { bot });
      } finally {
        if (prior === undefined) delete process.env.DISCORD_CLIENT_ID;
        else process.env.DISCORD_CLIENT_ID = prior;
      }

      expect(res._status).toBe(204);

      // Bot was asked for its member info first (to resolve the role
      // id we grant channel perms to), then asked to create the
      // category + four channels. DISCORD_CLIENT_ID has to be set
      // because Discord rejects `/guilds/:id/members/@me` for bots.
      expect(bot.getGuildBotMemberCalls).toHaveLength(1);
      expect(bot.getGuildBotMemberCalls[0].guildId).toBe(guildId);
      expect(bot.getGuildBotMemberCalls[0].botUserId).toBe(TEST_CLIENT_ID);

      // Five createGuildChannel calls in order: category, threads,
      // posts, announcements, discussion.
      expect(bot.createChannelCalls).toHaveLength(5);
      const [cat, threads, posts, announcements, discussion] = bot.createChannelCalls;
      expect(cat.opts.name).toBe('SWUTrade');
      expect(cat.opts.type).toBe(4);
      expect(threads.opts.name).toBe('swutrade-threads');
      expect(threads.opts.type).toBe(0);
      expect(threads.opts.parent_id).toBe(`channel-${guildId}`); // category id
      expect(posts.opts.name).toBe('swutrade-posts');
      expect(posts.opts.type).toBe(0);
      expect(announcements.opts.name).toBe('swutrade-announcements');
      expect(announcements.opts.type).toBe(0);
      expect(discussion.opts.name).toBe('swutrade-discussion');
      expect(discussion.opts.type).toBe(0);

      // Permission overwrites: threads is VIEW-only for @everyone,
      // posts + discussion are full chat, announcements is view+react.
      const everyoneAllow = (call: typeof threads): string | undefined =>
        (call.opts.permission_overwrites ?? []).find(o => o.id === guildId)?.allow;
      expect(everyoneAllow(threads)).toBe('1024');
      // Posts + discussion: full chat (view + read history + add reactions
      // + send messages + embed links + attach files).
      expect(everyoneAllow(posts)).toBe(String(0x400 | 0x10000 | 0x40 | 0x800 | 0x4000 | 0x8000));
      expect(everyoneAllow(discussion)).toBe(String(0x400 | 0x10000 | 0x40 | 0x800 | 0x4000 | 0x8000));
      // Announcements: read-only (view + read history + reactions, no send).
      expect(everyoneAllow(announcements)).toBe(String(0x400 | 0x10000 | 0x40));

      // The created channel ids were persisted on the row.
      const db = getDb();
      const [row] = await db
        .select()
        .from(botInstalledGuilds)
        .where(eq(botInstalledGuilds.guildId, guildId))
        .limit(1);
      // Each createGuildChannel returns `channel-${guildId}` in the
      // fake — so every column gets the same value here. In production
      // each call returns a unique id; the test only checks that the
      // ids round-trip into the DB.
      expect(row.categoryId).toBe(`channel-${guildId}`);
      expect(row.tradesChannelId).toBe(`channel-${guildId}`);
      expect(row.postsChannelId).toBe(`channel-${guildId}`);
      expect(row.announcementsChannelId).toBe(`channel-${guildId}`);
      expect(row.discussionChannelId).toBe(`channel-${guildId}`);
    });

    it('APPLICATION_AUTHORIZED skips channel creation when every category piece is already in place (re-install idempotency)', async () => {
      const guildId = `e2e-reinstall-${Date.now()}`;
      cleanupGuildIds.push(guildId);

      // Pre-seed the guild row with the full set of category ids to
      // simulate a second APPLICATION_AUTHORIZED firing on a guild
      // we already installed into. Re-create would orphan the
      // original category + channels.
      const db = getDb();
      await db.insert(botInstalledGuilds).values({
        guildId,
        guildName: 'Re-install Test',
        guildIcon: null,
        categoryId: 'pre-existing-cat',
        tradesChannelId: 'pre-existing-threads',
        postsChannelId: 'pre-existing-posts',
        announcementsChannelId: 'pre-existing-announcements',
        discussionChannelId: 'pre-existing-discussion',
      });

      const bot = makeFakeBot();
      const res = mockResponse();

      await dispatchBotPayload('events', {
        type: 1,
        event: {
          type: 'APPLICATION_AUTHORIZED',
          data: {
            integration_type: 0,
            scopes: ['bot', 'applications.commands'],
            user: { id: 'installer-user', username: 'Installer' },
            guild: { id: guildId, name: 'Re-install Test', icon: null },
          },
        },
      }, res, { bot });

      expect(res._status).toBe(204);
      // No bot calls at all — short-circuited before getGuildBotMember.
      expect(bot.getGuildBotMemberCalls).toEqual([]);
      expect(bot.createChannelCalls).toEqual([]);

      // Existing channel ids are preserved.
      const [row] = await db
        .select()
        .from(botInstalledGuilds)
        .where(eq(botInstalledGuilds.guildId, guildId))
        .limit(1);
      expect(row.categoryId).toBe('pre-existing-cat');
      expect(row.tradesChannelId).toBe('pre-existing-threads');
      expect(row.postsChannelId).toBe('pre-existing-posts');
    });

    it('APPLICATION_AUTHORIZED still succeeds when createGuildChannel throws (e.g. missing MANAGE_CHANNELS) — row written, tradesChannelId null, error logged', async () => {
      const guildId = `e2e-perms-${Date.now()}`;
      cleanupGuildIds.push(guildId);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const bot = makeFakeBot({
        createGuildChannel: async () => {
          // Simulate Discord's 403 when the bot lacks MANAGE_CHANNELS.
          throw new Error('Discord bot API POST /guilds/.../channels failed: 403 Missing Permissions');
        },
      });
      const res = mockResponse();

      try {
        await dispatchBotPayload('events', {
          type: 1,
          event: {
            type: 'APPLICATION_AUTHORIZED',
            data: {
              integration_type: 0,
              scopes: ['bot', 'applications.commands'],
              user: { id: 'installer-user', username: 'Installer' },
              guild: { id: guildId, name: 'Perms Missing Test', icon: null },
            },
          },
        }, res, { bot });

        // Install never fails on auto-create errors.
        expect(res._status).toBe(204);

        // Row was still written — the install is the source of truth.
        const db = getDb();
        const [row] = await db
          .select()
          .from(botInstalledGuilds)
          .where(eq(botInstalledGuilds.guildId, guildId))
          .limit(1);
        expect(row).toBeTruthy();
        expect(row.guildName).toBe('Perms Missing Test');
        // No channel id persisted because the create threw.
        expect(row.tradesChannelId).toBeNull();

        // The error was logged so we can grep for it in production.
        expect(consoleSpy).toHaveBeenCalledWith(
          'discord-bot: auto-create channel failed',
          expect.any(Error),
        );
      } finally {
        consoleSpy.mockRestore();
      }
    });

    describe('member outreach on fresh install', () => {
      it('DMs every existing member of the guild (except the installer) with an invite embed + enroll button', async () => {
        const guildId = `e2e-outreach-${Date.now()}`;
        cleanupGuildIds.push(guildId);

        // Seed three users + their memberships in the guild being
        // installed. One is the installer (skipped), one is a regular
        // member (gets the invite), one has autoEnrollOnBotInstall set
        // (gets the confirmation variant + enrolment flip).
        const installer = await createTestUser({ handle: `installer-${guildId}` });
        const regular = await createTestUser({ handle: `regular-${guildId}` });
        const autoOptIn = await createTestUser({ handle: `auto-${guildId}` });

        const db = getDb();
        await db.update(users).set({ autoEnrollOnBotInstall: true }).where(eq(users.id, autoOptIn.id));
        for (const u of [installer, regular, autoOptIn]) {
          await db.insert(userGuildMemberships).values({
            id: `ugm-${u.id}-${guildId}`,
            userId: u.id,
            guildId,
            guildName: 'Outreach Test',
            guildIcon: null,
            canManage: false,
            enrolled: false,
            includeInRollups: false,
            appearInQueries: false,
          });
        }

        const bot = makeFakeBot();
        const res = mockResponse();
        await dispatchBotPayload('events', {
          type: 1,
          event: {
            type: 'APPLICATION_AUTHORIZED',
            data: {
              integration_type: 0,
              scopes: ['bot', 'applications.commands'],
              user: { id: installer.id, username: 'Installer' },
              guild: { id: guildId, name: 'Outreach Test', icon: null },
            },
          },
        }, res, { bot });

        expect(res._status).toBe(204);

        // Welcome DM went to the installer; outreach DMs went to the
        // OTHER two (not the installer). Both the regular + auto-opt-in
        // users get a DM but with different embed shapes.
        const regularDm = bot.sendCalls.find(c => c.userId === regular.id);
        const autoDm = bot.sendCalls.find(c => c.userId === autoOptIn.id);
        const installerDm = bot.sendCalls.find(c => c.userId === installer.id);

        expect(installerDm, 'installer got the welcome DM').toBeTruthy();
        expect(regularDm, 'regular member got an invite DM').toBeTruthy();
        expect(autoDm, 'auto-enroll user got a confirmation DM').toBeTruthy();

        // Invite embed has an Enroll button with the server-invite custom_id.
        const inviteButton = regularDm?.body.components?.[0]?.components?.[0];
        expect(inviteButton?.custom_id).toBe(`server-invite:${guildId}:enroll`);
        expect(regularDm?.body.embeds?.[0].title).toContain('Outreach Test');

        // Auto-enroll variant has no action buttons (just the embed).
        expect(autoDm?.body.components ?? []).toHaveLength(0);
        expect(autoDm?.body.embeds?.[0].title).toContain("You're enrolled");

        // DB confirms the auto-opt-in user was flipped to enrolled.
        const [autoMembership] = await db
          .select()
          .from(userGuildMemberships)
          .where(and(
            eq(userGuildMemberships.userId, autoOptIn.id),
            eq(userGuildMemberships.guildId, guildId),
          ))
          .limit(1);
        expect(autoMembership.enrolled).toBe(true);
        expect(autoMembership.includeInRollups).toBe(true);
        expect(autoMembership.appearInQueries).toBe(true);

        // DB confirms the regular member is NOT enrolled (invite is opt-in).
        const [regularMembership] = await db
          .select()
          .from(userGuildMemberships)
          .where(and(
            eq(userGuildMemberships.userId, regular.id),
            eq(userGuildMemberships.guildId, guildId),
          ))
          .limit(1);
        expect(regularMembership.enrolled).toBe(false);

        await installer.cleanup();
        await regular.cleanup();
        await autoOptIn.cleanup();
      });

      it('skips the outreach DM when a user opted out via dmServerNewInstall=false', async () => {
        const guildId = `e2e-optout-${Date.now()}`;
        cleanupGuildIds.push(guildId);

        const installer = await createTestUser({ handle: `installer-${guildId}` });
        const optedOut = await createTestUser({ handle: `opted-out-${guildId}` });

        const db = getDb();
        await db.update(users).set({ dmServerNewInstall: false }).where(eq(users.id, optedOut.id));
        await db.insert(userGuildMemberships).values({
          id: `ugm-${optedOut.id}-${guildId}`,
          userId: optedOut.id,
          guildId,
          guildName: 'Opt Out Test',
          guildIcon: null,
          canManage: false,
          enrolled: false,
          includeInRollups: false,
          appearInQueries: false,
        });

        const bot = makeFakeBot();
        const res = mockResponse();
        await dispatchBotPayload('events', {
          type: 1,
          event: {
            type: 'APPLICATION_AUTHORIZED',
            data: {
              integration_type: 0,
              scopes: ['bot', 'applications.commands'],
              user: { id: installer.id, username: 'Installer' },
              guild: { id: guildId, name: 'Opt Out Test', icon: null },
            },
          },
        }, res, { bot });

        const outreachDm = bot.sendCalls.find(c => c.userId === optedOut.id);
        expect(outreachDm, 'user with dmServerNewInstall=false gets no DM').toBeUndefined();

        await installer.cleanup();
        await optedOut.cleanup();
      });

      it('does NOT re-DM members on re-authorization (only fires on fresh install)', async () => {
        const guildId = `e2e-reauth-outreach-${Date.now()}`;
        cleanupGuildIds.push(guildId);

        // Pre-seed the guild row — simulates a guild already installed.
        const db = getDb();
        await db.insert(botInstalledGuilds).values({
          guildId,
          guildName: 'Pre-existing',
          guildIcon: null,
        });

        const member = await createTestUser({ handle: `member-${guildId}` });
        await db.insert(userGuildMemberships).values({
          id: `ugm-${member.id}-${guildId}`,
          userId: member.id,
          guildId,
          guildName: 'Pre-existing',
          guildIcon: null,
          canManage: false,
          enrolled: false,
          includeInRollups: false,
          appearInQueries: false,
        });

        const bot = makeFakeBot();
        const res = mockResponse();
        await dispatchBotPayload('events', {
          type: 1,
          event: {
            type: 'APPLICATION_AUTHORIZED',
            data: {
              integration_type: 0,
              scopes: ['bot', 'applications.commands'],
              user: { id: `installer-${guildId}`, username: 'Installer' },
              guild: { id: guildId, name: 'Pre-existing', icon: null },
            },
          },
        }, res, { bot });

        const outreachDm = bot.sendCalls.find(c => c.userId === member.id);
        expect(outreachDm, 'no outreach on re-auth of an existing install').toBeUndefined();

        await member.cleanup();
      });
    });

    describe('server-invite Enroll button (interaction)', () => {
      it('click flips the viewer\'s enrollment row + responds with UPDATE_MESSAGE confirmation', async () => {
        const guildId = `e2e-enroll-click-${Date.now()}`;
        cleanupGuildIds.push(guildId);
        const user = await createTestUser();

        const db = getDb();
        await db.insert(botInstalledGuilds).values({
          guildId, guildName: 'Click Test', guildIcon: null,
        });
        await db.insert(userGuildMemberships).values({
          id: `ugm-${user.id}-${guildId}`,
          userId: user.id,
          guildId,
          guildName: 'Click Test',
          guildIcon: null,
          canManage: false,
          enrolled: false,
          includeInRollups: false,
          appearInQueries: false,
        });

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3, // MESSAGE_COMPONENT
            data: { custom_id: `server-invite:${guildId}:enroll` },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as { type: number; data?: { embeds?: Array<{ title?: string }> } };
        expect(body.type).toBe(7); // UPDATE_MESSAGE
        expect(body.data?.embeds?.[0].title).toMatch(/Enrolled in Click Test/);

        const [row] = await db
          .select()
          .from(userGuildMemberships)
          .where(and(
            eq(userGuildMemberships.userId, user.id),
            eq(userGuildMemberships.guildId, guildId),
          ))
          .limit(1);
        expect(row.enrolled).toBe(true);
        expect(row.includeInRollups).toBe(true);
        expect(row.appearInQueries).toBe(true);

        await user.cleanup();
      });

      it('clicking the button when not a member of the guild returns a helpful ephemeral (no state change)', async () => {
        const guildId = `e2e-non-member-${Date.now()}`;
        cleanupGuildIds.push(guildId);
        const user = await createTestUser();

        // Seed only the guild row, NOT a membership. Triggers the
        // "you're not a member — sync your Discord memberships again"
        // path.
        const db = getDb();
        await db.insert(botInstalledGuilds).values({
          guildId, guildName: 'Ghost Server', guildIcon: null,
        });

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: `server-invite:${guildId}:enroll` },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as { type: number; data?: { content?: string } };
        expect(body.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE (ephemeral)
        expect(body.data?.content).toMatch(/not a member/i);

        await user.cleanup();
      });
    });

    it('APPLICATION_AUTHORIZED without a guild (user-install) is a no-op', async () => {
      const res = mockResponse();
      await dispatchBotPayload('events', {
        type: 1,
        event: {
          type: 'APPLICATION_AUTHORIZED',
          data: {
            integration_type: 1,
            scopes: ['identify'],
            user: { id: 'user-installer', username: 'Solo User' },
            // no guild object
          },
        },
      }, res);

      // Still 204 — we don't reject, just nothing to write.
      expect(res._status).toBe(204);
    });

    it('unknown event types are acked (2xx) so Discord doesn\'t retry', async () => {
      const res = mockResponse();
      await dispatchBotPayload('events', {
        type: 1,
        event: { type: 'SOME_FUTURE_EVENT', data: {} },
      }, res);
      expect(res._status).toBe(204);
    });
  });

  it('unknown action returns 404', async () => {
    const res = mockResponse();
    await dispatchBotPayload('who-knows', {}, res);
    expect(res._status).toBe(404);
  });

  /**
   * Full round-trip through the default handler, including signature
   * verification + body canonicalization. Mirrors the exact path
   * Discord's Developer Portal hits when it saves an Interactions
   * Endpoint URL: compact-JSON PING, Ed25519 sig over timestamp+body.
   *
   * Regression guard: @vercel/node pre-parses JSON bodies, so the
   * handler must re-serialize `req.body` to reconstruct the bytes
   * that were signed. Previously this path tried to read the raw
   * stream (already consumed) and failed with 401, which surfaces
   * to Discord as "interactions endpoint url could not be verified".
   */
  describe('signature-verified handler', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyHex = extractRawEd25519PublicKey(publicKey);

    it('accepts a signed PING after re-serializing a @vercel/node-parsed body', async () => {
      process.env.DISCORD_APP_PUBLIC_KEY = publicKeyHex;

      // Discord sends compact JSON — mirror that with JSON.stringify
      // of a plain object. @vercel/node would then JSON.parse it and
      // hand us back the parsed object on req.body.
      const payload = { type: 1 };
      const serialized = JSON.stringify(payload);
      const parsedByVercel = JSON.parse(serialized);

      const timestamp = String(Math.floor(Date.now() / 1000));
      const message = Buffer.concat([Buffer.from(timestamp), Buffer.from(serialized)]);
      const signature = sign(null, message, privateKey).toString('hex');

      const req = mockRequest({
        method: 'POST',
        body: parsedByVercel,
        query: { action: 'interactions' },
        headers: {
          'x-signature-ed25519': signature,
          'x-signature-timestamp': timestamp,
        },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ type: 1 });
    });

    it('rejects when the signature doesn\'t match the canonicalized body', async () => {
      process.env.DISCORD_APP_PUBLIC_KEY = publicKeyHex;

      // Sign one body, deliver a different one — verification fails.
      const signedBody = JSON.stringify({ type: 1 });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const message = Buffer.concat([Buffer.from(timestamp), Buffer.from(signedBody)]);
      const signature = sign(null, message, privateKey).toString('hex');

      const req = mockRequest({
        method: 'POST',
        body: { type: 2 }, // different payload
        query: { action: 'interactions' },
        headers: {
          'x-signature-ed25519': signature,
          'x-signature-timestamp': timestamp,
        },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(401);
    });
  });
});
