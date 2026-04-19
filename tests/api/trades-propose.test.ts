import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handlePropose } from '../../api/trades.js';
import { dispatchBotPayload } from '../../api/bot.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeProposals, users, type TradeCardSnapshot } from '../../lib/schema.js';
import type { DiscordBotClient, DiscordMessageBody } from '../../lib/discordBot.js';
import type { CommunicationPref } from '../../lib/threadConsent.js';
import { createBaseFakeBot } from './discordFakes.js';

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
  editCalls: Array<{ channelId: string; messageId: string; body: DiscordMessageBody }>;
  threadCalls: Array<{ parentChannelId: string; name: string }>;
  addMemberCalls: Array<{ threadId: string; userId: string }>;
  threadPosts: Array<{ channelId: string; body: DiscordMessageBody }>;
  deleteCalls: string[];
}

function makeFakeBot(opts: FakeBotOpts = {}): FakeBot {
  const sendCalls: FakeBot['sendCalls'] = [];
  const editCalls: FakeBot['editCalls'] = [];
  const threadCalls: FakeBot['threadCalls'] = [];
  const addMemberCalls: FakeBot['addMemberCalls'] = [];
  const threadPosts: FakeBot['threadPosts'] = [];
  const deleteCalls: string[] = [];
  let sendSeq = 0;
  return Object.assign(
    createBaseFakeBot({
      async postChannelMessage(channelId, body) {
        threadPosts.push({ channelId, body });
        return { id: opts.messageId ?? 'thread-msg-1', channel_id: channelId };
      },
      async editChannelMessage(channelId, messageId, body) {
        editCalls.push({ channelId, messageId, body });
      },
      async createDmChannel() { return { id: opts.channelId ?? 'dm-1' }; },
      async sendDirectMessage(userId, body) {
        sendCalls.push({ userId, body });
        if (opts.shouldFailSend) throw new Error('simulated DM failure');
        sendSeq += 1;
        // The first send uses the configured ids (keeps existing
        // test assertions stable). Subsequent sends in the same test
        // — e.g. approval DMs on top of the proposal DM — get distinct
        // suffixed ids so tests can tell them apart.
        if (sendSeq === 1) {
          return {
            id: opts.messageId ?? 'msg-1',
            channel_id: opts.channelId ?? 'dm-1',
          };
        }
        return {
          id: `${opts.messageId ?? 'msg'}-${sendSeq}`,
          channel_id: `${opts.channelId ?? 'dm'}-${sendSeq}`,
        };
      },
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
    }),
    {
      sendCalls,
      editCalls,
      threadCalls,
      addMemberCalls,
      threadPosts,
      deleteCalls,
    },
  );
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
      // Default prefs (allow/allow) surface 4 buttons: Accept,
      // Counter, Decline, Request thread.
      expect(bot.sendCalls).toHaveLength(1);
      const call = bot.sendCalls[0];
      expect(call.userId).toBe(recipient.id); // discordId === id in test fixture
      expect(call.body.embeds?.[0].title).toContain('Trade proposal from');
      const actionRow = call.body.components?.[0];
      expect(actionRow?.components).toHaveLength(4);
      expect(actionRow?.components?.[0].custom_id).toContain(`trade-proposal:${id}:accept`);
      expect(actionRow?.components?.[1].custom_id).toContain(`trade-proposal:${id}:counter`);
      expect(actionRow?.components?.[2].custom_id).toContain(`trade-proposal:${id}:decline`);
      expect(actionRow?.components?.[3].custom_id).toContain(`trade-proposal:${id}:request-thread`);

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
      // Thread-immediately needs both sides pref-opted-in.
      const proposer = await createTestUser({ communicationPref: 'prefer' });
      const recipient = await createTestUser({ communicationPref: 'prefer' });
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
      const proposer = await createTestUser({ communicationPref: 'prefer' });
      const recipient = await createTestUser({ communicationPref: 'prefer' });
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
      const proposer = await createTestUser({ communicationPref: 'prefer' });
      const recipient = await createTestUser({ communicationPref: 'prefer' });
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

  // --- Phase-1 consent matrix -----------------------------------------------

  /**
   * Parameterized sweep of every (proposer_pref × recipient_pref)
   * pair. `deliveryForPair` is unit-tested in isolation, but this
   * table pins the INTEGRATION of the pref into the propose endpoint
   * — proving that each pair correctly:
   *   - 'thread-immediately' → creates a thread (TRADES_CHANNEL_ID set)
   *   - 'dm-with-request'   → DMs with 4 buttons (request-thread included)
   *   - 'dm-only'           → DMs with 3 buttons (no request-thread)
   *
   * Column 4 is the expected DM button count for the DM-path cases.
   * Thread-immediately cases use the thread-post path instead; the
   * DM send isn't invoked, so button-count assertions are N/A.
   */
  describe('communication-pref delivery matrix', () => {
    const ORIGINAL_ENV = process.env.TRADES_CHANNEL_ID;
    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.TRADES_CHANNEL_ID;
      else process.env.TRADES_CHANNEL_ID = ORIGINAL_ENV;
    });

    type Expected = 'thread-immediately' | 'dm-with-request' | 'dm-only';
    const prefs: CommunicationPref[] = ['prefer', 'auto-accept', 'allow', 'dm-only'];
    const cases: Array<[CommunicationPref, CommunicationPref, Expected]> = [];
    for (const p of prefs) {
      for (const r of prefs) {
        let expected: Expected;
        if (p === 'dm-only' || r === 'dm-only') {
          expected = 'dm-only';
        } else {
          const threadPositive = (x: CommunicationPref) => x === 'prefer' || x === 'auto-accept';
          expected = threadPositive(p) && threadPositive(r) ? 'thread-immediately' : 'dm-with-request';
        }
        cases.push([p, r, expected]);
      }
    }

    it.each(cases)(
      'proposer=%s × recipient=%s → %s',
      async (proposerPref, recipientPref, expected) => {
        // Every case runs with TRADES_CHANNEL_ID set so the
        // thread-immediately branch is reachable; dm-with-request
        // and dm-only cases still land in DM (matrix gates thread
        // attempt by pref, not by env alone).
        process.env.TRADES_CHANNEL_ID = 'parent-channel-matrix';

        const proposer = await createTestUser({ communicationPref: proposerPref });
        const recipient = await createTestUser({ communicationPref: recipientPref });
        fixtures.push(proposer, recipient);

        const bot = makeFakeBot({
          thread: { id: `thread-${proposerPref}-${recipientPref}`, parentId: 'parent-channel-matrix' },
          channelId: 'dm-x',
          messageId: 'msg-x',
        });
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
        const id = (res._json as { id: string }).id;
        createdProposalIds.push(id);

        if (expected === 'thread-immediately') {
          expect(bot.threadCalls).toHaveLength(1);
          expect(bot.threadPosts).toHaveLength(1);
          expect(bot.sendCalls).toHaveLength(0);
        } else {
          // DM path — no thread attempt, one DM send.
          expect(bot.threadCalls).toHaveLength(0);
          expect(bot.sendCalls).toHaveLength(1);
          const row = bot.sendCalls[0].body.components?.[0];
          const count = row?.components?.length ?? 0;
          if (expected === 'dm-with-request') {
            expect(count).toBe(4);
            const requestBtn = row?.components?.[3];
            expect(requestBtn?.custom_id).toContain(':request-thread');
          } else {
            expect(count).toBe(3);
            const customIds = (row?.components ?? []).map(c => c.custom_id ?? '');
            expect(customIds.some(c => c.includes('request-thread'))).toBe(false);
          }
        }
      },
    );
  });

  // --- Peer-scope override ---------------------------------------------------

  /**
   * Step 7 integration proof: a peer-scoped override on both sides
   * flips the delivery outcome vs what the self-scoped prefs alone
   * would produce. If this test fails but the matrix sweep passes,
   * `handlePropose` has stopped going through `resolvePref` and is
   * reading `users.communicationPref` directly again.
   */
  describe('communication-pref peer overrides', () => {
    const ORIGINAL_ENV = process.env.TRADES_CHANNEL_ID;
    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.TRADES_CHANNEL_ID;
      else process.env.TRADES_CHANNEL_ID = ORIGINAL_ENV;
    });

    it('self=allow × self=allow + mutual peer overrides to prefer → thread-immediately', async () => {
      process.env.TRADES_CHANNEL_ID = 'parent-channel-peer-override';

      const proposer = await createTestUser({ communicationPref: 'allow' });
      const recipient = await createTestUser({ communicationPref: 'allow' });
      fixtures.push(proposer, recipient);

      const { userPeerPrefs: peerPrefsTable } = await import('../../lib/schema.js');
      const db = getDb();
      await db.insert(peerPrefsTable).values([
        { userId: proposer.id, peerUserId: recipient.id, communicationPref: 'prefer' },
        { userId: recipient.id, peerUserId: proposer.id, communicationPref: 'prefer' },
      ]);

      const bot = makeFakeBot({
        thread: { id: 'thread-peer-override', parentId: 'parent-channel-peer-override' },
      });
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
      // Base matrix (self × self = allow × allow) would have produced
      // dm-with-request. The override flipped it.
      expect(bot.threadCalls).toHaveLength(1);
      expect(bot.threadPosts).toHaveLength(1);
      expect(bot.sendCalls).toHaveLength(0);

      const id = (res._json as { id: string }).id;
      createdProposalIds.push(id);
      // Clean up peer pref rows — fixtures.cleanup only handles the
      // viewer side via users cascade, but we inserted two rows with
      // different viewers so cover both.
      await db.delete(peerPrefsTable).where(eq(peerPrefsTable.userId, proposer.id));
      await db.delete(peerPrefsTable).where(eq(peerPrefsTable.userId, recipient.id));
    });

    it('self=prefer × self=prefer + recipient peer-overrides to dm-only → dm-only', async () => {
      process.env.TRADES_CHANNEL_ID = 'parent-channel-peer-override-2';

      const proposer = await createTestUser({ communicationPref: 'prefer' });
      const recipient = await createTestUser({ communicationPref: 'prefer' });
      fixtures.push(proposer, recipient);

      const { userPeerPrefs: peerPrefsTable } = await import('../../lib/schema.js');
      const db = getDb();
      // Recipient doesn't want threads specifically with this proposer,
      // even though their global default is 'prefer'. Matrix resolves
      // to dm-only because either side of 'dm-only' forces dm-only.
      await db.insert(peerPrefsTable).values({
        userId: recipient.id,
        peerUserId: proposer.id,
        communicationPref: 'dm-only',
      });

      const bot = makeFakeBot({ channelId: 'dm-peer', messageId: 'msg-peer' });
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
      expect(bot.threadCalls).toHaveLength(0);
      expect(bot.sendCalls).toHaveLength(1);
      // dm-only → no request-thread button (3 buttons, not 4).
      const row = bot.sendCalls[0].body.components?.[0];
      expect(row?.components).toHaveLength(3);

      const id = (res._json as { id: string }).id;
      createdProposalIds.push(id);
      await db.delete(peerPrefsTable).where(eq(peerPrefsTable.userId, recipient.id));
    });
  });

  // --- Request-thread button handler ----------------------------------------

  /**
   * End-to-end flow tests for the three new button interactions —
   * request-thread / approve-thread / decline-thread. Each test
   * seeds a delivered DM proposal, dispatches a signed click via
   * `dispatchBotPayload`, and asserts the resulting DB state + bot
   * side-effects.
   */
  describe('request-thread button flow', () => {
    const ORIGINAL_ENV = process.env.TRADES_CHANNEL_ID;
    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.TRADES_CHANNEL_ID;
      else process.env.TRADES_CHANNEL_ID = ORIGINAL_ENV;
    });

    /** Seed a delivered-to-DM pending proposal with the given prefs.
     *  Temporarily clears TRADES_CHANNEL_ID for the propose itself
     *  (so the row lands in DM with known ids), then restores it so
     *  the subsequent request-thread click can use the env. */
    async function seedProposalWithPrefs(opts: {
      proposerPref: CommunicationPref;
      recipientPref: CommunicationPref;
    }) {
      const proposer = await createTestUser({ communicationPref: opts.proposerPref });
      const recipient = await createTestUser({ communicationPref: opts.recipientPref });
      fixtures.push(proposer, recipient);

      const envBefore = process.env.TRADES_CHANNEL_ID;
      delete process.env.TRADES_CHANNEL_ID;
      try {
        const bot = makeFakeBot({ channelId: 'dm-init', messageId: 'msg-init' });
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
        const tradeId = (res._json as { id: string }).id;
        createdProposalIds.push(tradeId);
        return { proposer, recipient, tradeId };
      } finally {
        if (envBefore === undefined) delete process.env.TRADES_CHANNEL_ID;
        else process.env.TRADES_CHANNEL_ID = envBefore;
      }
    }

    function clickButton(tradeId: string, action: string, clickerDiscordId: string): Record<string, unknown> {
      return {
        type: 3,
        data: { custom_id: `trade-proposal:${tradeId}:${action}` },
        user: { id: clickerDiscordId },
      };
    }

    it('manual-decide: request edits clicker DM (type 7) and sends approval DM to counterpart', async () => {
      const { proposer, recipient, tradeId } = await seedProposalWithPrefs({
        proposerPref: 'allow',
        recipientPref: 'allow',
      });

      const bot = makeFakeBot({ channelId: 'dm-2', messageId: 'approval-msg' });
      const res = mockResponse();
      // Proposer clicks Request-thread — counterpart is recipient.
      await dispatchBotPayload('interactions', clickButton(tradeId, 'request-thread', proposer.id), res, { bot });

      const body = res._json as { type: number; data?: { embeds?: Array<{ fields?: Array<{ name?: string; value?: string }> }>; components?: Array<{ components?: Array<{ custom_id?: string }> }> } };
      expect(body.type).toBe(7); // UPDATE_MESSAGE — edits clicker's DM in-place
      // The "thread requested" field should be present.
      const statusField = body.data?.embeds?.[0]?.fields?.find(f => f.value?.includes('Thread requested'));
      expect(statusField).toBeTruthy();
      // Accept/Counter/Decline preserved; request-thread gone.
      const btnIds = body.data?.components?.[0]?.components?.map(c => c.custom_id ?? '') ?? [];
      expect(btnIds).toHaveLength(3);
      expect(btnIds.some(id => id.includes('request-thread'))).toBe(false);

      // Approval DM sent to the recipient (counterpart).
      expect(bot.sendCalls).toHaveLength(1);
      expect(bot.sendCalls[0].userId).toBe(recipient.id);
      const approvalButtons = bot.sendCalls[0].body.components?.[0]?.components ?? [];
      const approvalIds = approvalButtons.map(c => c.custom_id ?? '');
      expect(approvalIds.some(id => id.endsWith(':approve-thread'))).toBe(true);
      expect(approvalIds.some(id => id.endsWith(':decline-thread'))).toBe(true);

      // Row tracks approval DM ids for later edit.
      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
      expect(row.threadApprovalDmChannelId).toBeTruthy();
      expect(row.threadApprovalDmMessageId).toBeTruthy();
      expect(row.discordThreadId).toBeNull(); // not yet approved
    });

    it('manual-decide → approve: creates thread, edits both DMs, populates thread ids', async () => {
      process.env.TRADES_CHANNEL_ID = 'parent-ch-approve';
      const { proposer, recipient, tradeId } = await seedProposalWithPrefs({
        proposerPref: 'allow',
        recipientPref: 'allow',
      });

      // Step 1: proposer clicks request-thread → approval DM sent.
      const bot1 = makeFakeBot();
      await dispatchBotPayload('interactions', clickButton(tradeId, 'request-thread', proposer.id), mockResponse(), { bot: bot1 });

      // Step 2: recipient clicks approve-thread.
      const bot2 = makeFakeBot({ thread: { id: 'thread-approved', parentId: 'parent-ch-approve' } });
      const res = mockResponse();
      await dispatchBotPayload('interactions', clickButton(tradeId, 'approve-thread', recipient.id), res, { bot: bot2 });

      const body = res._json as { type: number; data?: { embeds?: Array<{ fields?: Array<{ value?: string }> }> } };
      expect(body.type).toBe(7); // UPDATE_MESSAGE edits clicker (approver) DM
      const movedField = body.data?.embeds?.[0]?.fields?.find(f => f.value?.includes('Moved to thread'));
      expect(movedField).toBeTruthy();

      // Thread was created, both members added, proposal posted.
      expect(bot2.threadCalls).toHaveLength(1);
      expect(bot2.addMemberCalls.map(c => c.userId).sort()).toEqual([proposer.id, recipient.id].sort());
      expect(bot2.threadPosts).toHaveLength(1);

      // Requester's (proposer's) DM was PATCHed. Proposer isn't the
      // original DM recipient; the discord_dm_* ids point at the
      // recipient's DM (since the initial proposal DM went to them).
      // So the PATCH hits the recipient's DM, which carries the
      // "moved to thread" message. Confirm one edit fired.
      expect(bot2.editCalls).toHaveLength(1);
      expect(bot2.editCalls[0].body.embeds?.[0]?.fields?.some(f => f.value?.includes('Moved to thread'))).toBe(true);

      // Row updated with thread ids.
      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
      expect(row.discordThreadId).toBe('thread-approved');
      expect(row.discordThreadParentChannelId).toBe('parent-ch-approve');
    });

    it('manual-decide → decline: edits both DMs to declined variant, thread stays null', async () => {
      const { proposer, recipient, tradeId } = await seedProposalWithPrefs({
        proposerPref: 'allow',
        recipientPref: 'allow',
      });

      // Step 1: proposer requests.
      const bot1 = makeFakeBot();
      await dispatchBotPayload('interactions', clickButton(tradeId, 'request-thread', proposer.id), mockResponse(), { bot: bot1 });

      // Step 2: recipient declines.
      const bot2 = makeFakeBot();
      const res = mockResponse();
      await dispatchBotPayload('interactions', clickButton(tradeId, 'decline-thread', recipient.id), res, { bot: bot2 });

      const body = res._json as { type: number; data?: { embeds?: Array<{ fields?: Array<{ value?: string }> }>; components?: Array<{ components?: Array<unknown> }> } };
      expect(body.type).toBe(7);
      const declinedField = body.data?.embeds?.[0]?.fields?.find(f => f.value?.includes('declined'));
      expect(declinedField).toBeTruthy();
      // Accept/Counter/Decline RESTORED (proposal still live).
      expect(body.data?.components?.[0]?.components).toHaveLength(3);

      // Requester's DM edited with the same declined variant.
      expect(bot2.editCalls).toHaveLength(1);

      // No thread created.
      expect(bot2.threadCalls).toHaveLength(0);
      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
      expect(row.discordThreadId).toBeNull();
    });

    it('auto-approve: single-click request creates thread immediately (no approval DM)', async () => {
      process.env.TRADES_CHANNEL_ID = 'parent-ch-auto';
      const { proposer, tradeId } = await seedProposalWithPrefs({
        proposerPref: 'allow',
        recipientPref: 'auto-accept',
      });

      const bot = makeFakeBot({ thread: { id: 'thread-auto', parentId: 'parent-ch-auto' } });
      const res = mockResponse();
      await dispatchBotPayload('interactions', clickButton(tradeId, 'request-thread', proposer.id), res, { bot });

      const body = res._json as { type: number; data?: { embeds?: Array<{ fields?: Array<{ value?: string }> }> } };
      expect(body.type).toBe(7);
      expect(body.data?.embeds?.[0]?.fields?.some(f => f.value?.includes('Moved to thread'))).toBe(true);

      // Thread created directly.
      expect(bot.threadCalls).toHaveLength(1);
      expect(bot.threadPosts).toHaveLength(1);
      // No approval DM.
      expect(bot.sendCalls).toHaveLength(0);

      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
      expect(row.discordThreadId).toBe('thread-auto');
    });

    it('auto-decline: ephemeral response, no state change, DMs untouched', async () => {
      const { proposer, tradeId } = await seedProposalWithPrefs({
        proposerPref: 'allow',
        recipientPref: 'dm-only',
      });

      const bot = makeFakeBot();
      const res = mockResponse();
      await dispatchBotPayload('interactions', clickButton(tradeId, 'request-thread', proposer.id), res, { bot });

      const body = res._json as { type: number; data?: { content?: string; flags?: number } };
      expect(body.type).toBe(4); // ephemeral channel message
      expect(body.data?.flags).toBe(64);
      expect(body.data?.content).toMatch(/don't accept thread requests/i);

      // No side effects.
      expect(bot.threadCalls).toHaveLength(0);
      expect(bot.sendCalls).toHaveLength(0);
      expect(bot.editCalls).toHaveLength(0);

      const db = getDb();
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
      expect(row.discordThreadId).toBeNull();
      expect(row.threadApprovalDmChannelId).toBeNull();
    });
  });
});
