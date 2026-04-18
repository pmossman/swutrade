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
import { botInstalledGuilds, tradeProposals, users, type TradeCardSnapshot } from '../../lib/schema.js';
import type { DiscordBotClient, DiscordMessageBody } from '../../lib/discordBot.js';

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
  sendCalls: Array<{ userId: string; body: DiscordMessageBody }>;
  createChannelCalls: CreateChannelCall[];
  getGuildBotMemberCalls: GetGuildBotMemberCall[];
} {
  const sendCalls: Array<{ userId: string; body: DiscordMessageBody }> = [];
  const createChannelCalls: CreateChannelCall[] = [];
  const getGuildBotMemberCalls: GetGuildBotMemberCall[] = [];
  return {
    sendCalls,
    createChannelCalls,
    getGuildBotMemberCalls,
    async postChannelMessage() { throw new Error('unused'); },
    async editChannelMessage() { /* unused in type-7 path */ },
    async createDmChannel() { return { id: 'dm-fake' }; },
    async sendDirectMessage(userId, body) {
      sendCalls.push({ userId, body });
      return { id: 'notify-msg-1', channel_id: 'dm-fake' };
    },
    async getGuild() { throw new Error('unused'); },
    async createPrivateThread() { throw new Error('unused'); },
    async addThreadMember() { throw new Error('unused'); },
    async deleteChannel() { throw new Error('unused'); },
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
  };
}

function cardSnapshot(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1.0 };
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

    describe('trade-proposal buttons', () => {
      /**
       * Seeds a pending proposal + the two user rows needed for
       * the button handler to resolve recipient + proposer. Returns
       * everything the test needs to simulate a Discord button click.
       */
      async function seedProposal(opts: { status?: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'countered' } = {}) {
        const proposer = await createTestUser();
        const recipient = await createTestUser();
        const tradeId = crypto.randomUUID();
        const db = getDb();
        await db.insert(tradeProposals).values({
          id: tradeId,
          proposerUserId: proposer.id,
          recipientUserId: recipient.id,
          status: opts.status ?? 'pending',
          offeringCards: [cardSnapshot('p-1', 2)],
          receivingCards: [cardSnapshot('p-2', 1)],
          message: 'swap?',
          deliveryStatus: 'delivered',
          discordDmChannelId: 'dm-channel-x',
          discordDmMessageId: 'msg-x',
        });
        return { proposer, recipient, tradeId };
      }

      async function cleanup(tradeId: string, userIds: string[]) {
        const db = getDb();
        await db.delete(tradeProposals).where(eq(tradeProposals.id, tradeId)).catch(() => {});
        // User cleanup is handled by createTestUser().cleanup but we
        // don't hold those refs here — seed returns the raw ids.
        // Tests that need stricter cleanup track proposers/recipients
        // via their own arrays.
        void userIds;
      }

      function clickButton(tradeId: string, action: 'accept' | 'decline', clickerDiscordId: string): Record<string, unknown> {
        return {
          type: 3,
          data: { custom_id: `trade-proposal:${tradeId}:${action}` },
          user: { id: clickerDiscordId },
        };
      }

      it('Accept: flips status → accepted, DMs the proposer, returns UPDATE_MESSAGE (type 7)', async () => {
        const { proposer, recipient, tradeId } = await seedProposal();
        const bot = makeFakeBot();
        const res = mockResponse();

        await dispatchBotPayload(
          'interactions',
          clickButton(tradeId, 'accept', recipient.id),
          res,
          { bot },
        );

        expect(res._status).toBe(200);
        const body = res._json as { type: number; data?: { components?: unknown[] } };
        expect(body.type).toBe(7);
        // Component row is stripped — no re-clicking stale buttons.
        expect(body.data?.components).toEqual([]);

        // DB updated.
        const db = getDb();
        const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
        expect(row.status).toBe('accepted');
        expect(row.respondedAt).toBeTruthy();

        // Proposer got a notification DM.
        expect(bot.sendCalls).toHaveLength(1);
        expect(bot.sendCalls[0].userId).toBe(proposer.id);
        expect(bot.sendCalls[0].body.embeds?.[0].title).toMatch(/accepted/i);

        await cleanup(tradeId, [proposer.id, recipient.id]);
      });

      it('Decline: flips status → declined and proposer DM says "declined"', async () => {
        const { proposer, recipient, tradeId } = await seedProposal();
        const bot = makeFakeBot();
        const res = mockResponse();

        await dispatchBotPayload(
          'interactions',
          clickButton(tradeId, 'decline', recipient.id),
          res,
          { bot },
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(7);

        const db = getDb();
        const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
        expect(row.status).toBe('declined');

        expect(bot.sendCalls[0].body.embeds?.[0].title).toMatch(/declined/i);

        await cleanup(tradeId, [proposer.id, recipient.id]);
      });

      it('rejects clicks from someone who is not the recipient (ephemeral error, no state change)', async () => {
        const { proposer, recipient, tradeId } = await seedProposal();
        const intruder = await createTestUser();
        const bot = makeFakeBot();
        const res = mockResponse();

        await dispatchBotPayload(
          'interactions',
          clickButton(tradeId, 'accept', intruder.id),
          res,
          { bot },
        );

        const body = res._json as { type: number; data?: { flags?: number } };
        expect(body.type).toBe(4);
        expect(body.data?.flags).toBe(64); // ephemeral

        // Trade unchanged.
        const db = getDb();
        const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
        expect(row.status).toBe('pending');

        // No proposer DM.
        expect(bot.sendCalls).toHaveLength(0);

        await intruder.cleanup();
        await cleanup(tradeId, [proposer.id, recipient.id]);
      });

      it('unknown trade id returns an ephemeral "no longer exists" message', async () => {
        const bot = makeFakeBot();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          clickButton('00000000-0000-0000-0000-000000000000', 'accept', 'discord-user-1'),
          res,
          { bot },
        );
        const body = res._json as { type: number; data?: { content?: string; flags?: number } };
        expect(body.type).toBe(4);
        expect(body.data?.content).toMatch(/no longer exists/i);
      });

      it('already-resolved proposal is idempotent: refreshes message body, does NOT re-DM proposer', async () => {
        const { proposer, recipient, tradeId } = await seedProposal({ status: 'accepted' });
        const bot = makeFakeBot();
        const res = mockResponse();

        await dispatchBotPayload(
          'interactions',
          clickButton(tradeId, 'accept', recipient.id),
          res,
          { bot },
        );

        expect((res._json as { type: number }).type).toBe(7);
        // No second DM fired — status was already accepted.
        expect(bot.sendCalls).toHaveLength(0);

        await cleanup(tradeId, [proposer.id, recipient.id]);
      });

      it('Counter: returns an ephemeral deep-link to the web composer, no state change, no DM', async () => {
        const { proposer, recipient, tradeId } = await seedProposal();
        const bot = makeFakeBot();
        const res = mockResponse();

        await dispatchBotPayload(
          'interactions',
          clickButton(tradeId, 'counter' as 'accept' | 'decline', recipient.id),
          res,
          { bot, origin: 'https://beta.swutrade.com' },
        );

        const body = res._json as { type: number; data?: { content?: string; flags?: number } };
        expect(body.type).toBe(4); // ephemeral channel message
        expect(body.data?.flags).toBe(64);
        expect(body.data?.content).toContain(`/?counter=${tradeId}`);
        expect(body.data?.content).toContain('beta.swutrade.com');

        // No state change — original stays pending so the recipient
        // can still Accept/Decline from the DM if they change their
        // mind mid-compose.
        const db = getDb();
        const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
        expect(row.status).toBe('pending');
        expect(row.respondedAt).toBeNull();

        // No proposer notification — that only fires on submit.
        expect(bot.sendCalls).toHaveLength(0);

        await cleanup(tradeId, [proposer.id, recipient.id]);
      });

      it('already-countered proposal is idempotent: refreshes to purple/countered body', async () => {
        const { proposer, recipient, tradeId } = await seedProposal({ status: 'countered' });
        const bot = makeFakeBot();
        const res = mockResponse();

        await dispatchBotPayload(
          'interactions',
          clickButton(tradeId, 'accept', recipient.id),
          res,
          { bot },
        );

        const body = res._json as { type: number; data?: { embeds?: Array<{ fields?: Array<{ value?: string }> }>; components?: unknown[] } };
        expect(body.type).toBe(7);
        expect(body.data?.components).toEqual([]);
        const statusField = body.data?.embeds?.[0].fields?.find(f => f.value?.includes('Countered'));
        expect(statusField).toBeTruthy();

        // No proposer DM — nothing changed.
        expect(bot.sendCalls).toHaveLength(0);

        await cleanup(tradeId, [proposer.id, recipient.id]);
      });

      it('cancelled proposals block the click with an ephemeral (no state change, no DM)', async () => {
        const { proposer, recipient, tradeId } = await seedProposal({ status: 'cancelled' });
        const bot = makeFakeBot();
        const res = mockResponse();

        await dispatchBotPayload(
          'interactions',
          clickButton(tradeId, 'accept', recipient.id),
          res,
          { bot },
        );

        const body = res._json as { type: number; data?: { content?: string } };
        expect(body.type).toBe(4);
        expect(body.data?.content).toMatch(/cancelled/);
        expect(bot.sendCalls).toHaveLength(0);

        await cleanup(tradeId, [proposer.id, recipient.id]);
      });

      it('malformed custom_id (wrong action) silently acks so Discord doesn\'t retry', async () => {
        const { proposer, recipient, tradeId } = await seedProposal();
        const bot = makeFakeBot();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: `trade-proposal:${tradeId}:bogus` },
            user: { id: recipient.id },
          },
          res,
          { bot },
        );
        expect((res._json as { type: number }).type).toBe(6); // deferred update
        await cleanup(tradeId, [proposer.id, recipient.id]);
      });
    });

    describe('prefs buttons (registry-driven)', () => {
      it('pref:communicationPref:open returns a 4-button selector with current highlighted, buttons carrying the new `pref:*` commit ids', async () => {
        const user = await createTestUser({ communicationPref: 'auto-accept' });
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'pref:communicationPref:open' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as {
          type: number;
          data?: { flags?: number; components?: Array<{ components?: Array<{ style?: number; custom_id?: string; label?: string }> }> };
        };
        expect(body.type).toBe(4);
        expect(body.data?.flags).toBe(64);
        const buttons = body.data?.components?.[0]?.components ?? [];
        expect(buttons).toHaveLength(4);
        expect(buttons.map(b => b.custom_id)).toEqual([
          'pref:communicationPref:set:prefer',
          'pref:communicationPref:set:auto-accept',
          'pref:communicationPref:set:allow',
          'pref:communicationPref:set:dm-only',
        ]);
        // Current value rendered as success (style 3); others secondary (2).
        expect(buttons.find(b => b.custom_id === 'pref:communicationPref:set:auto-accept')?.style).toBe(3);
        expect(buttons.find(b => b.custom_id === 'pref:communicationPref:set:prefer')?.style).toBe(2);

        await user.cleanup();
      });

      it('pref:communicationPref:set:prefer updates users.communication_pref + returns UPDATE_MESSAGE confirmation', async () => {
        const user = await createTestUser({ communicationPref: 'allow' });
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'pref:communicationPref:set:prefer' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as { type: number; data?: { content?: string; components?: unknown[] } };
        expect(body.type).toBe(7);
        expect(body.data?.content).toMatch(/Prefer threads/);
        expect(body.data?.components).toEqual([]);

        const db = getDb();
        const [row] = await db
          .select({ communicationPref: users.communicationPref })
          .from(users)
          .where(eq(users.discordId, user.id))
          .limit(1);
        expect(row.communicationPref).toBe('prefer');

        await user.cleanup();
      });

      it('pref:dmTradeProposals:open returns On/Off buttons for a boolean pref, current highlighted', async () => {
        const user = await createTestUser();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'pref:dmTradeProposals:open' },
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
          'pref:dmTradeProposals:set:true',
          'pref:dmTradeProposals:set:false',
        ]);
        // Default for dmTradeProposals is true → On is success (3), Off secondary (2).
        expect(buttons[0].style).toBe(3);
        expect(buttons[1].style).toBe(2);

        await user.cleanup();
      });

      it('pref:dmMatchAlerts:set:true updates the boolean column', async () => {
        const user = await createTestUser();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'pref:dmMatchAlerts:set:true' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(7);

        const db = getDb();
        const [row] = await db
          .select({ dmMatchAlerts: users.dmMatchAlerts })
          .from(users)
          .where(eq(users.discordId, user.id))
          .limit(1);
        expect(row.dmMatchAlerts).toBe(true);

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

      it('pref:communicationPref:set:bogus defers + no DB write', async () => {
        const user = await createTestUser({ communicationPref: 'allow' });
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'pref:communicationPref:set:bogus' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(6);

        const db = getDb();
        const [row] = await db
          .select({ communicationPref: users.communicationPref })
          .from(users)
          .where(eq(users.discordId, user.id))
          .limit(1);
        expect(row.communicationPref).toBe('allow');

        await user.cleanup();
      });
    });

    describe('combined prefs view (pref:combo:<peerId>:open)', () => {
      it('returns a two-row ephemeral: self buttons up top, peer buttons below with Use-my-default', async () => {
        const viewer = await createTestUser({ communicationPref: 'allow' });
        const peer = await createTestUser();

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: `pref:combo:${peer.id}:open` },
            user: { id: viewer.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as {
          type: number;
          data?: {
            flags?: number;
            content?: string;
            components?: Array<{ components?: Array<{ style?: number; label?: string; custom_id?: string }> }>;
          };
        };
        expect(body.type).toBe(4);
        expect(body.data?.flags).toBe(64);
        expect(body.data?.content).toMatch(/Thread conversations/);
        expect(body.data?.content).toMatch(/Your default/i);
        expect(body.data?.content).toMatch(new RegExp(`<@${peer.id}>`));

        const rows = body.data?.components ?? [];
        expect(rows).toHaveLength(2);

        // Self row: 4 buttons, all emitting pref:communicationPref:set:<value>.
        const selfButtons = rows[0].components ?? [];
        expect(selfButtons).toHaveLength(4);
        for (const b of selfButtons) {
          expect(b.custom_id).toMatch(/^pref:communicationPref:set:/);
        }
        // Current self ('allow') highlighted success (3).
        expect(selfButtons.find(b => b.custom_id === 'pref:communicationPref:set:allow')?.style).toBe(3);

        // Peer row: 5 buttons (Use my default + 4 options), all peer-scoped to this peer id.
        const peerButtons = rows[1].components ?? [];
        expect(peerButtons).toHaveLength(5);
        expect(peerButtons[0].label).toBe('Use my default');
        expect(peerButtons[0].custom_id).toBe(`pref:peer:${peer.id}:communicationPref:set:inherit`);
        // No override set → Use-my-default highlighted.
        expect(peerButtons[0].style).toBe(3);
        for (const b of peerButtons.slice(1)) {
          expect(b.custom_id).toMatch(new RegExp(`^pref:peer:${peer.id}:communicationPref:set:`));
        }

        await viewer.cleanup();
        await peer.cleanup();
      });

      it('falls back to self-only selector when the peer id equals the viewer', async () => {
        // Shouldn't happen in practice (the proposal DM is always
        // from a different user), but belt-and-suspenders — we
        // render a usable UI rather than an invalid self-override.
        const viewer = await createTestUser();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: `pref:combo:${viewer.id}:open` },
            user: { id: viewer.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as {
          type: number;
          data?: { components?: Array<{ components?: Array<{ custom_id?: string }> }> };
        };
        expect(body.type).toBe(4);
        const rows = body.data?.components ?? [];
        expect(rows).toHaveLength(1);
        // Single row, self-only custom_ids.
        for (const b of rows[0].components ?? []) {
          expect(b.custom_id).toMatch(/^pref:communicationPref:set:/);
        }

        await viewer.cleanup();
      });
    });

    describe('peer prefs buttons (pref:peer:...)', () => {
      it('pref:peer:<peerId>:communicationPref:open returns Use-my-default + 4 option buttons, highlights override when set', async () => {
        const viewer = await createTestUser();
        const peer = await createTestUser();

        // Pre-seed an override so the handler's "highlight current override" path runs.
        const { userPeerPrefs } = await import('../../lib/schema.js');
        const db = getDb();
        await db.insert(userPeerPrefs).values({
          userId: viewer.id,
          peerUserId: peer.id,
          communicationPref: 'dm-only',
        });

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: `pref:peer:${peer.id}:communicationPref:open` },
            user: { id: viewer.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as {
          type: number;
          data?: { flags?: number; components?: Array<{ components?: Array<{ style?: number; label?: string; custom_id?: string }> }> };
        };
        expect(body.type).toBe(4);
        expect(body.data?.flags).toBe(64);
        const buttons = body.data?.components?.[0]?.components ?? [];
        expect(buttons.map(b => b.label)).toEqual([
          'Use my default', 'Prefer threads', 'Auto-accept requests', 'Allow (ask each time)', 'DM only',
        ]);
        // Override is 'dm-only' → DM only button is success (3).
        const dmOnly = buttons.find(b => b.custom_id === `pref:peer:${peer.id}:communicationPref:set:dm-only`);
        const inherit = buttons.find(b => b.custom_id === `pref:peer:${peer.id}:communicationPref:set:inherit`);
        expect(dmOnly?.style).toBe(3);
        expect(inherit?.style).toBe(2);

        await viewer.cleanup();
        await peer.cleanup();
      });

      it('pref:peer:<peerId>:communicationPref:set:prefer upserts the override + returns a peer-scoped confirmation', async () => {
        const viewer = await createTestUser();
        const peer = await createTestUser();

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: `pref:peer:${peer.id}:communicationPref:set:prefer` },
            user: { id: viewer.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as { type: number; data?: { content?: string } };
        expect(body.type).toBe(7);
        expect(body.data?.content).toMatch(/Prefer threads/);

        const { userPeerPrefs } = await import('../../lib/schema.js');
        const db = getDb();
        const [row] = await db
          .select()
          .from(userPeerPrefs)
          .where(and(
            eq(userPeerPrefs.userId, viewer.id),
            eq(userPeerPrefs.peerUserId, peer.id),
          ))
          .limit(1);
        expect(row?.communicationPref).toBe('prefer');

        await viewer.cleanup();
        await peer.cleanup();
      });

      it('pref:peer:<peerId>:communicationPref:set:inherit clears the override (null)', async () => {
        const viewer = await createTestUser({ communicationPref: 'allow' });
        const peer = await createTestUser();

        const { userPeerPrefs } = await import('../../lib/schema.js');
        const db = getDb();
        await db.insert(userPeerPrefs).values({
          userId: viewer.id,
          peerUserId: peer.id,
          communicationPref: 'dm-only',
        });

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: `pref:peer:${peer.id}:communicationPref:set:inherit` },
            user: { id: viewer.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as { type: number; data?: { content?: string } };
        expect(body.type).toBe(7);
        expect(body.data?.content).toMatch(/Override cleared/);
        // Confirmation quotes the now-effective self value (cascade falls back to 'allow').
        expect(body.data?.content).toMatch(/Allow/);

        const [row] = await db
          .select()
          .from(userPeerPrefs)
          .where(and(
            eq(userPeerPrefs.userId, viewer.id),
            eq(userPeerPrefs.peerUserId, peer.id),
          ))
          .limit(1);
        expect(row?.communicationPref).toBeNull();

        await viewer.cleanup();
        await peer.cleanup();
      });

      it('pref:peer:<self-id>:...:open rejects with an ephemeral — no self-override via peer scope', async () => {
        const viewer = await createTestUser();

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: `pref:peer:${viewer.id}:communicationPref:open` },
            user: { id: viewer.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(4);
        expect((res._json as { data?: { content?: string } }).data?.content)
          .toMatch(/override prefs against yourself/i);

        await viewer.cleanup();
      });

      it('pref:peer:<peerId>:unknownKey:open defers — registry rejects unknown peer-scoped keys', async () => {
        const viewer = await createTestUser();
        const peer = await createTestUser();

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: `pref:peer:${peer.id}:dmTradeProposals:open` },
            user: { id: viewer.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        // dmTradeProposals exists at scope=self but NOT scope=peer;
        // the handler should silently defer.
        expect((res._json as { type: number }).type).toBe(6);

        await viewer.cleanup();
        await peer.cleanup();
      });
    });

    describe('application commands (/swutrade settings + user context menu)', () => {
      it('slash /swutrade settings (no user) returns self-prefs index ephemeral with one button per Discord-surfaced self pref', async () => {
        const user = await createTestUser();
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 2, // APPLICATION_COMMAND
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
        );

        expect(res._status).toBe(200);
        const body = res._json as {
          type: number;
          data?: { flags?: number; content?: string; components?: Array<{ components?: Array<{ label?: string; custom_id?: string }> }> };
        };
        expect(body.type).toBe(4);
        expect(body.data?.flags).toBe(64);
        const buttons = body.data?.components?.[0]?.components ?? [];
        // Each Discord-surfaced self pref gets a button that opens its selector.
        const customIds = buttons.map(b => b.custom_id ?? '');
        expect(customIds.some(c => c === 'pref:communicationPref:open')).toBe(true);
        expect(customIds.every(c => c.startsWith('pref:') && c.endsWith(':open'))).toBe(true);

        await user.cleanup();
      });

      it('slash /swutrade settings user:@peer returns peer-prefs index ephemeral keyed to the peer id', async () => {
        const viewer = await createTestUser();
        const peer = await createTestUser();

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 2,
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
        );

        expect(res._status).toBe(200);
        const body = res._json as {
          type: number;
          data?: { flags?: number; content?: string; components?: Array<{ components?: Array<{ custom_id?: string }> }> };
        };
        expect(body.type).toBe(4);
        expect(body.data?.flags).toBe(64);
        expect(body.data?.content).toMatch(/preferences for/i);
        const buttons = body.data?.components?.[0]?.components ?? [];
        // At least one button exists + they all carry the peer id + :open action.
        expect(buttons.length).toBeGreaterThan(0);
        for (const b of buttons) {
          expect(b.custom_id).toMatch(new RegExp(`^pref:peer:${peer.id}:[^:]+:open$`));
        }

        await viewer.cleanup();
        await peer.cleanup();
      });

      it('slash with an unknown Discord id returns a helpful "not on SWUTrade" message', async () => {
        const viewer = await createTestUser();

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 2,
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
        );

        expect(res._status).toBe(200);
        const body = res._json as { type: number; data?: { content?: string } };
        expect(body.type).toBe(4);
        expect(body.data?.content).toMatch(/isn't on SWUTrade yet/i);

        await viewer.cleanup();
      });

      it('user context menu (type 2 command) returns the same peer-prefs index', async () => {
        const viewer = await createTestUser();
        const peer = await createTestUser();

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 2,
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
        );

        expect(res._status).toBe(200);
        const body = res._json as { type: number; data?: { content?: string } };
        expect(body.type).toBe(4);
        expect(body.data?.content).toMatch(/preferences for/i);

        await viewer.cleanup();
        await peer.cleanup();
      });

      it('slash /swutrade settings user:<self> rejects — no self-override via peer surface', async () => {
        const viewer = await createTestUser();

        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 2,
            data: {
              type: 1,
              name: 'swutrade',
              options: [
                {
                  type: 1,
                  name: 'settings',
                  options: [{ type: 6, name: 'user', value: viewer.id }],
                },
              ],
            },
            user: { id: viewer.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        expect((res._json as { data?: { content?: string } }).data?.content)
          .toMatch(/can't set per-trader prefs for yourself/i);

        await viewer.cleanup();
      });
    });

    // Legacy `comm-pref:*` custom_ids are retained during the
    // transition so in-flight DMs posted before the registry-driven
    // handler shipped keep working. Drop this block once deployed
    // DMs have had a release to roll over.
    describe('comm-pref buttons (legacy alias)', () => {
      it('comm-pref:open still works — selector renders using the new `pref:*` commit ids', async () => {
        const user = await createTestUser({ communicationPref: 'allow' });
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'comm-pref:open' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        const body = res._json as {
          type: number;
          data?: { components?: Array<{ components?: Array<{ custom_id?: string }> }> };
        };
        const customIds = body.data?.components?.[0]?.components?.map(b => b.custom_id) ?? [];
        // Selector is forward-compatible — clicks on these buttons
        // route through the new `pref:*` handler, not the legacy path.
        expect(customIds[0]).toMatch(/^pref:communicationPref:set:/);

        await user.cleanup();
      });

      it('comm-pref:set:dm-only still writes through to users.communication_pref', async () => {
        const user = await createTestUser({ communicationPref: 'allow' });
        const res = mockResponse();
        await dispatchBotPayload(
          'interactions',
          {
            type: 3,
            data: { custom_id: 'comm-pref:set:dm-only' },
            user: { id: user.id },
          },
          res,
        );

        expect(res._status).toBe(200);
        expect((res._json as { type: number }).type).toBe(7);

        const db = getDb();
        const [row] = await db
          .select({ communicationPref: users.communicationPref })
          .from(users)
          .where(eq(users.discordId, user.id))
          .limit(1);
        expect(row.communicationPref).toBe('dm-only');

        await user.cleanup();
      });
    });
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

    it('APPLICATION_AUTHORIZED auto-creates #swutrade-threads + persists the channel id when the bot client succeeds', async () => {
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
      // id we grant channel perms to), then asked to create the channel.
      // The caller must supply DISCORD_CLIENT_ID because Discord
      // rejects `/guilds/:id/members/@me` for bots.
      expect(bot.getGuildBotMemberCalls).toHaveLength(1);
      expect(bot.getGuildBotMemberCalls[0].guildId).toBe(guildId);
      expect(bot.getGuildBotMemberCalls[0].botUserId).toBe(TEST_CLIENT_ID);
      expect(bot.createChannelCalls).toHaveLength(1);
      const call = bot.createChannelCalls[0];
      expect(call.guildId).toBe(guildId);
      expect(call.opts.name).toBe('swutrade-threads');
      expect(call.opts.type).toBe(0);
      // Two overwrites: @everyone (role id == guild id) gets VIEW_CHANNEL
      // only; the bot's own role gets the full BOT_INSTALL_PERMISSIONS
      // bitfield so it can operate regardless of server-wide defaults.
      const overwrites = call.opts.permission_overwrites ?? [];
      expect(overwrites).toHaveLength(2);
      const everyone = overwrites.find(o => o.id === guildId);
      const botRole = overwrites.find(o => o.id === 'bot-role-1');
      expect(everyone?.allow).toBe('1024');
      expect(botRole?.allow).toBe('360777255952');

      // The created channel id was persisted on the row.
      const db = getDb();
      const [row] = await db
        .select()
        .from(botInstalledGuilds)
        .where(eq(botInstalledGuilds.guildId, guildId))
        .limit(1);
      expect(row.tradesChannelId).toBe(`channel-${guildId}`);
    });

    it('APPLICATION_AUTHORIZED skips channel creation when the row already has a tradesChannelId (re-install idempotency)', async () => {
      const guildId = `e2e-reinstall-${Date.now()}`;
      cleanupGuildIds.push(guildId);

      // Pre-seed the guild row with an existing channel id to simulate
      // a second APPLICATION_AUTHORIZED firing on a guild we already
      // installed into. Re-create would orphan the original channel.
      const db = getDb();
      await db.insert(botInstalledGuilds).values({
        guildId,
        guildName: 'Re-install Test',
        guildIcon: null,
        tradesChannelId: 'pre-existing-channel-id',
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

      // Existing channel id is preserved.
      const [row] = await db
        .select()
        .from(botInstalledGuilds)
        .where(eq(botInstalledGuilds.guildId, guildId))
        .limit(1);
      expect(row.tradesChannelId).toBe('pre-existing-channel-id');
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
