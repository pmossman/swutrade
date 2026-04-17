import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  mockRequest,
  mockResponse,
  createTestUser,
} from './helpers.js';
import handler, { dispatchBotPayload, resolveTestPublicKey } from '../../api/bot.js';
import { getDb } from '../../lib/db.js';
import { botInstalledGuilds, tradeProposals, type TradeCardSnapshot } from '../../lib/schema.js';
import type { DiscordBotClient, DiscordMessageBody } from '../../lib/discordBot.js';

function extractRawEd25519PublicKey(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(12).toString('hex');
}

function makeFakeBot(): DiscordBotClient & {
  sendCalls: Array<{ userId: string; body: DiscordMessageBody }>;
} {
  const sendCalls: Array<{ userId: string; body: DiscordMessageBody }> = [];
  return {
    sendCalls,
    async postChannelMessage() { throw new Error('unused'); },
    async editChannelMessage() { /* unused in type-7 path */ },
    async createDmChannel() { return { id: 'dm-fake' }; },
    async sendDirectMessage(userId, body) {
      sendCalls.push({ userId, body });
      return { id: 'notify-msg-1', channel_id: 'dm-fake' };
    },
    async getGuild() { throw new Error('unused'); },
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
      }, res);

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
