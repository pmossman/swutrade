import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handlePropose } from '../../api/trades.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeProposals, users, type TradeCardSnapshot } from '../../lib/schema.js';
import type { DiscordBotClient, DiscordMessageBody } from '../../lib/discordBot.js';

/** In-memory DiscordBotClient that records every call. Lets tests
 *  assert both the payload shape AND the delivery semantics
 *  (delivery_status + persisted channel/message ids) without
 *  touching real Discord. */
interface FakeBotOpts {
  shouldFailSend?: boolean;
  channelId?: string;
  messageId?: string;
  /** Enable the thread path. When set, `createPrivateThread` returns
   *  a fake thread and `postChannelMessage` records the embed send.
   *  Leave unset for legacy DM-path tests. */
  thread?: {
    id: string;
    parentId: string;
    /** `createPrivateThread` throws (e.g. bot perms missing). */
    failCreate?: boolean;
    /** `addThreadMember` throws (e.g. recipient isn't a real Discord
     *  user — like the dev-seed fakes). Exercises the orphan-cleanup
     *  path where the thread was created but add-member failed. */
    failAddMember?: boolean;
  };
}

interface FakeBot extends DiscordBotClient {
  sendCalls: Array<{ userId: string; body: DiscordMessageBody }>;
  threadCalls: Array<{ parentChannelId: string; name: string }>;
  addMemberCalls: Array<{ threadId: string; userId: string }>;
  threadPosts: Array<{ channelId: string; body: DiscordMessageBody }>;
  deleteCalls: string[];
}

function makeFakeBot(opts: FakeBotOpts = {}): FakeBot {
  const sendCalls: FakeBot['sendCalls'] = [];
  const threadCalls: FakeBot['threadCalls'] = [];
  const addMemberCalls: FakeBot['addMemberCalls'] = [];
  const threadPosts: FakeBot['threadPosts'] = [];
  const deleteCalls: string[] = [];
  return {
    sendCalls,
    threadCalls,
    addMemberCalls,
    threadPosts,
    deleteCalls,
    async postChannelMessage(channelId, body) {
      threadPosts.push({ channelId, body });
      return { id: opts.messageId ?? 'thread-msg-1', channel_id: channelId };
    },
    async editChannelMessage() { /* not exercised here */ },
    async createDmChannel() { return { id: opts.channelId ?? 'dm-1' }; },
    async sendDirectMessage(userId, body) {
      sendCalls.push({ userId, body });
      if (opts.shouldFailSend) throw new Error('simulated DM failure');
      return { id: opts.messageId ?? 'msg-1', channel_id: opts.channelId ?? 'dm-1' };
    },
    async getGuild() { throw new Error('unused in propose tests'); },
    async createPrivateThread(parentChannelId, threadOpts) {
      threadCalls.push({ parentChannelId, name: threadOpts.name });
      if (opts.thread?.failCreate) throw new Error('simulated thread create failure');
      if (!opts.thread) throw new Error('thread flow not opted-in; set opts.thread');
      return { id: opts.thread.id, parent_id: opts.thread.parentId };
    },
    async addThreadMember(threadId, userId) {
      addMemberCalls.push({ threadId, userId });
      if (opts.thread?.failAddMember) throw new Error('simulated add-member failure');
    },
    async deleteChannel(channelId) {
      deleteCalls.push(channelId);
    },
  };
}

/**
 * Covers POST /api/trades/propose — the create-a-proposal path
 * invoked from the ProposeView composer. Validation surface is
 * wide (recipient existence, self-send, empty payload, private
 * recipient) so each gate gets its own pin.
 *
 * Slice 2 does NOT DM the recipient — that comes with the bot
 * interaction wiring in slice 3. These tests lock the DB-side
 * contract only.
 */
describeWithDb('POST /api/trades/propose', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdProposalIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdProposalIds) {
      await db.delete(tradeProposals).where(eq(tradeProposals.id, id)).catch(() => {});
    }
    createdProposalIds.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  function snapshot(productId: string, qty = 1): TradeCardSnapshot {
    return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1.0 };
  }

  it('creates a pending proposal and returns its id', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        recipientHandle: recipient.handle,
        offeringCards: [snapshot('p-1', 2)],
        receivingCards: [snapshot('p-2', 1)],
        message: 'hey wanna trade?',
      },
    });
    const res = mockResponse();
    await handlePropose(req, res, { bot: makeFakeBot() });

    expect(res._status).toBe(201);
    const body = res._json as { id: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    createdProposalIds.push(body.id);

    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, body.id)).limit(1);
    expect(row).toBeTruthy();
    expect(row.proposerUserId).toBe(proposer.id);
    expect(row.recipientUserId).toBe(recipient.id);
    expect(row.status).toBe('pending');
    expect(row.message).toBe('hey wanna trade?');
    expect(row.offeringCards).toHaveLength(1);
    expect(row.offeringCards[0]).toMatchObject({ productId: 'p-1', qty: 2 });
    expect(row.receivingCards[0]).toMatchObject({ productId: 'p-2', qty: 1 });
  });

  it('401s when unauthenticated', async () => {
    const recipient = await createTestUser();
    fixtures.push(recipient);

    const req = mockRequest({
      method: 'POST',
      body: {
        recipientHandle: recipient.handle,
        offeringCards: [snapshot('p-1')],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handlePropose(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(401);
  });

  it('405s on non-POST', async () => {
    const proposer = await createTestUser();
    fixtures.push(proposer);
    const cookie = await sealTestCookie(proposer.id);

    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handlePropose(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(405);
  });

  it('400s when both sides are empty (no-op proposals make no sense)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        recipientHandle: recipient.handle,
        offeringCards: [],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handlePropose(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(400);
  });

  it('accepts a one-sided proposal (only offering or only receiving)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        recipientHandle: recipient.handle,
        offeringCards: [snapshot('p-only')],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handlePropose(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(201);
    const id = (res._json as { id: string }).id;
    createdProposalIds.push(id);
  });

  it('400s when proposing to yourself', async () => {
    const user = await createTestUser();
    fixtures.push(user);
    const cookie = await sealTestCookie(user.id);

    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        recipientHandle: user.handle,
        offeringCards: [snapshot('p-1')],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handlePropose(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(400);
  });

  it('404s for an unknown recipient handle', async () => {
    const proposer = await createTestUser();
    fixtures.push(proposer);
    const cookie = await sealTestCookie(proposer.id);

    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        recipientHandle: `nobody-${Date.now()}`,
        offeringCards: [snapshot('p-1')],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handlePropose(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(404);
  });

  it('404s for a recipient whose profile is private (without confirming existence)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const db = getDb();
    await db.update(users).set({ profileVisibility: 'private' }).where(eq(users.id, recipient.id));

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        recipientHandle: recipient.handle,
        offeringCards: [snapshot('p-1')],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handlePropose(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(404);
  });

  describe('Discord DM delivery', () => {
    it('marks delivery_status=delivered and persists channel + message ids on send success', async () => {
      const proposer = await createTestUser();
      const recipient = await createTestUser();
      fixtures.push(proposer, recipient);

      const bot = makeFakeBot({ channelId: 'dm-happy', messageId: 'msg-happy' });
      const cookie = await sealTestCookie(proposer.id);
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
        body: {
          recipientHandle: recipient.handle,
          offeringCards: [snapshot('p-1')],
          receivingCards: [snapshot('p-2')],
        },
      });
      const res = mockResponse();
      await handlePropose(req, res, { bot });

      expect(res._status).toBe(201);
      expect(res._json).toMatchObject({ deliveryStatus: 'delivered' });
      const id = (res._json as { id: string }).id;
      createdProposalIds.push(id);

      // Bot was called with the recipient's discordId + a button row.
      expect(bot.sendCalls).toHaveLength(1);
      const call = bot.sendCalls[0];
      expect(call.userId).toBe(recipient.id); // discordId === id in test fixture
      expect(call.body.embeds?.[0].title).toContain('Trade proposal from');
      const actionRow = call.body.components?.[0];
      expect(actionRow?.components).toHaveLength(3);
      expect(actionRow?.components?.[0].custom_id).toContain(`trade-proposal:${id}:accept`);
      expect(actionRow?.components?.[1].custom_id).toContain(`trade-proposal:${id}:counter`);
      expect(actionRow?.components?.[2].custom_id).toContain(`trade-proposal:${id}:decline`);

      // Row reflects the delivery.
      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
      expect(row.deliveryStatus).toBe('delivered');
      expect(row.discordDmChannelId).toBe('dm-happy');
      expect(row.discordDmMessageId).toBe('msg-happy');
    });

    it('marks delivery_status=failed but STILL saves the row when the DM send throws', async () => {
      const proposer = await createTestUser();
      const recipient = await createTestUser();
      fixtures.push(proposer, recipient);

      const bot = makeFakeBot({ shouldFailSend: true });
      const cookie = await sealTestCookie(proposer.id);
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
        body: {
          recipientHandle: recipient.handle,
          offeringCards: [snapshot('p-1')],
          receivingCards: [],
        },
      });
      const res = mockResponse();
      await handlePropose(req, res, { bot });

      // Proposer still gets a 201 — the trade exists, just wasn't
      // delivered via DM. Client uses delivery_status to surface a
      // "share link manually" fallback.
      expect(res._status).toBe(201);
      expect(res._json).toMatchObject({ deliveryStatus: 'failed' });
      const id = (res._json as { id: string }).id;
      createdProposalIds.push(id);

      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
      expect(row).toBeTruthy();
      expect(row.deliveryStatus).toBe('failed');
      expect(row.discordDmChannelId).toBeNull();
      expect(row.discordDmMessageId).toBeNull();
    });
  });

  describe('Discord thread delivery (TRADES_CHANNEL_ID set)', () => {
    const ORIGINAL_ENV = process.env.TRADES_CHANNEL_ID;
    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.TRADES_CHANNEL_ID;
      else process.env.TRADES_CHANNEL_ID = ORIGINAL_ENV;
    });

    it('creates a private thread, adds both users, posts the embed, and stores thread ids', async () => {
      process.env.TRADES_CHANNEL_ID = 'parent-channel-1';
      const proposer = await createTestUser();
      const recipient = await createTestUser();
      fixtures.push(proposer, recipient);

      const bot = makeFakeBot({ thread: { id: 'thread-abc', parentId: 'parent-channel-1' } });
      const cookie = await sealTestCookie(proposer.id);
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
        body: {
          recipientHandle: recipient.handle,
          offeringCards: [snapshot('p-1')],
          receivingCards: [snapshot('p-2')],
        },
      });
      const res = mockResponse();
      await handlePropose(req, res, { bot });

      expect(res._status).toBe(201);
      expect(res._json).toMatchObject({ deliveryStatus: 'delivered' });
      const id = (res._json as { id: string }).id;
      createdProposalIds.push(id);

      // Thread was created in the configured parent channel.
      expect(bot.threadCalls).toHaveLength(1);
      expect(bot.threadCalls[0].parentChannelId).toBe('parent-channel-1');
      expect(bot.threadCalls[0].name).toContain('trade-');

      // Both users added.
      const addedIds = bot.addMemberCalls.map(c => c.userId).sort();
      expect(addedIds).toEqual([proposer.id, recipient.id].sort());

      // Embed posted inside the thread (channelId === thread id).
      expect(bot.threadPosts).toHaveLength(1);
      expect(bot.threadPosts[0].channelId).toBe('thread-abc');
      expect(bot.threadPosts[0].body.embeds?.[0].title).toContain('Trade proposal from');

      // DM path NOT taken.
      expect(bot.sendCalls).toHaveLength(0);

      // Row reflects thread delivery.
      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
      expect(row.deliveryStatus).toBe('delivered');
      expect(row.discordThreadId).toBe('thread-abc');
      expect(row.discordThreadParentChannelId).toBe('parent-channel-1');
      // Channel + message ids reflect the thread (thread id doubles as the
      // channel id for PATCH message edits on the Accept/Decline path).
      expect(row.discordDmChannelId).toBe('thread-abc');
      expect(row.discordDmMessageId).toBe('thread-msg-1');
    });

    it('falls back to DM when thread creation fails (user not in guild, bot perms missing, etc.)', async () => {
      process.env.TRADES_CHANNEL_ID = 'parent-channel-1';
      const proposer = await createTestUser();
      const recipient = await createTestUser();
      fixtures.push(proposer, recipient);

      const bot = makeFakeBot({
        thread: { id: 'ignored', parentId: 'ignored', failCreate: true },
        channelId: 'dm-fallback',
        messageId: 'msg-fallback',
      });
      const cookie = await sealTestCookie(proposer.id);
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
        body: {
          recipientHandle: recipient.handle,
          offeringCards: [snapshot('p-1')],
          receivingCards: [],
        },
      });
      const res = mockResponse();
      await handlePropose(req, res, { bot });

      expect(res._status).toBe(201);
      expect(res._json).toMatchObject({ deliveryStatus: 'delivered' });
      const id = (res._json as { id: string }).id;
      createdProposalIds.push(id);

      // Thread attempted, failed → DM was used.
      expect(bot.threadCalls).toHaveLength(1);
      expect(bot.sendCalls).toHaveLength(1);
      expect(bot.sendCalls[0].userId).toBe(recipient.id);

      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
      expect(row.discordThreadId).toBeNull();
      expect(row.discordDmChannelId).toBe('dm-fallback');
      expect(row.discordDmMessageId).toBe('msg-fallback');
    });

    it('cleans up the orphan thread when addThreadMember fails (e.g. recipient is a dev-seed fake)', async () => {
      process.env.TRADES_CHANNEL_ID = 'parent-channel-1';
      const proposer = await createTestUser();
      const recipient = await createTestUser();
      fixtures.push(proposer, recipient);

      // Thread creation succeeds, but addThreadMember fails — mirrors
      // the real "fake Discord ID" case. Must delete the orphan
      // thread and fall back to DM.
      const bot = makeFakeBot({
        thread: { id: 'orphan-thread-1', parentId: 'parent-channel-1', failAddMember: true },
        channelId: 'dm-cleanup',
        messageId: 'msg-cleanup',
      });
      const cookie = await sealTestCookie(proposer.id);
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
        body: {
          recipientHandle: recipient.handle,
          offeringCards: [snapshot('p-1')],
          receivingCards: [],
        },
      });
      const res = mockResponse();
      await handlePropose(req, res, { bot });

      expect(res._status).toBe(201);
      const id = (res._json as { id: string }).id;
      createdProposalIds.push(id);

      // Thread was created, add-member failed, cleanup ran, DM took over.
      expect(bot.threadCalls).toHaveLength(1);
      expect(bot.deleteCalls).toEqual(['orphan-thread-1']);
      expect(bot.sendCalls).toHaveLength(1);

      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
      expect(row.discordThreadId).toBeNull();
      expect(row.discordDmChannelId).toBe('dm-cleanup');
    });

    it('uses DM path when TRADES_CHANNEL_ID is unset (existing behavior preserved)', async () => {
      delete process.env.TRADES_CHANNEL_ID;
      const proposer = await createTestUser();
      const recipient = await createTestUser();
      fixtures.push(proposer, recipient);

      const bot = makeFakeBot({ channelId: 'dm-legacy', messageId: 'msg-legacy' });
      const cookie = await sealTestCookie(proposer.id);
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
        body: {
          recipientHandle: recipient.handle,
          offeringCards: [snapshot('p-1')],
          receivingCards: [],
        },
      });
      const res = mockResponse();
      await handlePropose(req, res, { bot });

      expect(res._status).toBe(201);
      const id = (res._json as { id: string }).id;
      createdProposalIds.push(id);

      // No thread attempted, DM succeeded.
      expect(bot.threadCalls).toHaveLength(0);
      expect(bot.sendCalls).toHaveLength(1);

      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
      expect(row.discordThreadId).toBeNull();
      expect(row.discordDmChannelId).toBe('dm-legacy');
    });
  });

  it('400s on malformed body (missing offeringCards etc.)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        recipientHandle: recipient.handle,
        // intentionally missing offeringCards + receivingCards
      },
    });
    const res = mockResponse();
    await handlePropose(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(400);
  });
});
