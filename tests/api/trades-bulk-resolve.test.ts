import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleBulkResolve } from '../../api/trades.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import {
  tradeProposals,
  proposalEvents,
  type TradeCardSnapshot,
} from '../../lib/schema.js';
import type { DiscordBotClient, DiscordMessageBody } from '../../lib/discordBot.js';

/**
 * POST /api/trades?action=bulk-resolve — decline/cancel many
 * proposals in one call, coalescing proposer notifications so a
 * fast burst doesn't trip Discord's DM-channel-creation rate limit
 * (error 40003).
 */

function snapshot(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1.0 };
}

function makeFakeBot(opts: {
  /** When set, `editChannelMessage` throws on its N-th call (1-indexed). */
  failEditOnNth?: number;
} = {}): DiscordBotClient & {
  editCalls: Array<{ channelId: string; messageId: string; body: DiscordMessageBody }>;
  sendCalls: Array<{ userId: string; body: DiscordMessageBody }>;
} {
  const editCalls: Array<{ channelId: string; messageId: string; body: DiscordMessageBody }> = [];
  const sendCalls: Array<{ userId: string; body: DiscordMessageBody }> = [];
  return {
    editCalls,
    sendCalls,
    async postChannelMessage() { throw new Error('unused'); },
    async editChannelMessage(channelId, messageId, body) {
      editCalls.push({ channelId, messageId, body });
      if (opts.failEditOnNth !== undefined && editCalls.length === opts.failEditOnNth) {
        throw new Error(`simulated edit failure #${opts.failEditOnNth}`);
      }
    },
    async createDmChannel() { return { id: 'dm-bulk' }; },
    async sendDirectMessage(userId, body) {
      sendCalls.push({ userId, body });
      return { id: `msg-${sendCalls.length}`, channel_id: 'dm-bulk' };
    },
    async getGuild() { throw new Error('unused'); },
    async createPrivateThread() { throw new Error('unused'); },
    async addThreadMember() { throw new Error('unused'); },
    async deleteChannel() { throw new Error('unused'); },
    async createGuildChannel() { throw new Error('unused'); },
    async getGuildBotMember() { throw new Error('unused'); },
  };
}

async function seedProposal(overrides: {
  proposerUserId: string;
  recipientUserId: string;
  status?: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'countered';
  discordDmChannelId?: string | null;
  discordDmMessageId?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb();
  await db.insert(tradeProposals).values({
    id,
    proposerUserId: overrides.proposerUserId,
    recipientUserId: overrides.recipientUserId,
    status: overrides.status ?? 'pending',
    offeringCards: [snapshot('p-1', 2)],
    receivingCards: [snapshot('p-2', 1)],
    message: null,
    deliveryStatus: 'delivered',
    discordDmChannelId: overrides.discordDmChannelId ?? `dm-${id.slice(0, 8)}`,
    discordDmMessageId: overrides.discordDmMessageId ?? `msg-${id.slice(0, 8)}`,
  });
  return id;
}

// Stub sleep so tests don't actually wait between summary DMs.
const instantSleep = async () => {};

describeWithDb('POST /api/trades?action=bulk-resolve', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdIds) {
      await db.delete(proposalEvents).where(eq(proposalEvents.proposalId, id)).catch(() => {});
      await db.delete(tradeProposals).where(eq(tradeProposals.id, id)).catch(() => {});
    }
    createdIds.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('401 when unauthenticated', async () => {
    const req = mockRequest({ method: 'POST', body: { ids: ['x'], action: 'decline' } });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot: makeFakeBot(), sleep: instantSleep });
    expect(res._status).toBe(401);
  });

  it('400 on empty ids array', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { ids: [], action: 'decline' },
    });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot: makeFakeBot(), sleep: instantSleep });
    expect(res._status).toBe(400);
  });

  it('400 on more than 50 ids', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { ids, action: 'decline' },
    });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot: makeFakeBot(), sleep: instantSleep });
    expect(res._status).toBe(400);
  });

  it('400 on invalid action (e.g. accept)', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { ids: ['x'], action: 'accept' },
    });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot: makeFakeBot(), sleep: instantSleep });
    expect(res._status).toBe(400);
  });

  it('405 on non-POST', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot: makeFakeBot(), sleep: instantSleep });
    expect(res._status).toBe(405);
  });

  it('bulk decline across 2 distinct proposers → all ok, 2 summary DMs, 3 events, 3 edits', async () => {
    const proposerA = await createTestUser();
    const proposerB = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposerA, proposerB, recipient);

    const id1 = await seedProposal({ proposerUserId: proposerA.id, recipientUserId: recipient.id });
    const id2 = await seedProposal({ proposerUserId: proposerA.id, recipientUserId: recipient.id });
    const id3 = await seedProposal({ proposerUserId: proposerB.id, recipientUserId: recipient.id });
    createdIds.push(id1, id2, id3);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { ids: [id1, id2, id3], action: 'decline' },
    });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot, sleep: instantSleep });

    expect(res._status).toBe(200);
    const body = res._json as {
      results: Array<{ id: string; outcome: string }>;
      okCount: number;
      notificationsSent: number;
    };
    expect(body.okCount).toBe(3);
    expect(body.notificationsSent).toBe(2);
    expect(body.results).toHaveLength(3);
    for (const r of body.results) expect(r.outcome).toBe('ok');

    // All three proposals flipped to declined.
    const db = getDb();
    for (const id of [id1, id2, id3]) {
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
      expect(row.status).toBe('declined');
      expect(row.respondedAt).not.toBeNull();
    }

    // 3 declined events.
    const eventRows = await db.select().from(proposalEvents);
    const declinedEvents = eventRows.filter(e => e.type === 'declined' && [id1, id2, id3].includes(e.proposalId));
    expect(declinedEvents).toHaveLength(3);

    // 3 DM edits (original DMs re-rendered with declined banner).
    expect(bot.editCalls).toHaveLength(3);
    for (const call of bot.editCalls) {
      expect(call.body.components).toEqual([]);
    }

    // Exactly 2 summary DMs — one to each proposer. No per-proposal DMs.
    expect(bot.sendCalls).toHaveLength(2);
    const recipientsOfSummary = new Set(bot.sendCalls.map(c => c.userId));
    expect(recipientsOfSummary).toEqual(new Set([proposerA.id, proposerB.id]));
    // proposerA gets a "2 of your proposals were declined" summary.
    const aSummary = bot.sendCalls.find(c => c.userId === proposerA.id);
    expect(aSummary?.body.embeds?.[0].title).toMatch(/2 of your proposals were declined/);
    const bSummary = bot.sendCalls.find(c => c.userId === proposerB.id);
    expect(bSummary?.body.embeds?.[0].title).toMatch(/1 of your proposal was declined/);
  });

  it('bulk cancel (one proposer, the viewer) → all ok, NO summary DM, 3 cancelled events, 3 edits', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id1 = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    const id2 = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    const id3 = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id1, id2, id3);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { ids: [id1, id2, id3], action: 'cancel' },
    });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot, sleep: instantSleep });

    expect(res._status).toBe(200);
    const body = res._json as {
      results: Array<{ id: string; outcome: string }>;
      okCount: number;
      notificationsSent: number;
    };
    expect(body.okCount).toBe(3);
    expect(body.notificationsSent).toBe(0);

    const db = getDb();
    for (const id of [id1, id2, id3]) {
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
      expect(row.status).toBe('cancelled');
    }

    const eventRows = await db.select().from(proposalEvents);
    const cancelledEvents = eventRows.filter(e => e.type === 'cancelled' && [id1, id2, id3].includes(e.proposalId));
    expect(cancelledEvents).toHaveLength(3);

    // 3 in-place DM edits to the recipient's messages.
    expect(bot.editCalls).toHaveLength(3);

    // NO summary DMs — cancel doesn't coalesce notifications (the
    // recipient already sees the edit).
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('mixed outcomes: one already-resolved, one not-found, one ok — only the ok is summarized/edited', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const idOk = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    const idResolved = await seedProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'accepted',
    });
    createdIds.push(idOk, idResolved);
    const idMissing = '00000000-0000-0000-0000-000000000000';

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { ids: [idResolved, idMissing, idOk], action: 'decline' },
    });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot, sleep: instantSleep });

    expect(res._status).toBe(200);
    const body = res._json as {
      results: Array<{ id: string; outcome: string }>;
      okCount: number;
      notificationsSent: number;
    };
    const byId = new Map(body.results.map(r => [r.id, r.outcome]));
    expect(byId.get(idOk)).toBe('ok');
    expect(byId.get(idResolved)).toBe('already-resolved');
    expect(byId.get(idMissing)).toBe('not-found');
    expect(body.okCount).toBe(1);
    expect(body.notificationsSent).toBe(1);

    // Only the ok one generated Discord side effects.
    expect(bot.editCalls).toHaveLength(1);
    expect(bot.sendCalls).toHaveLength(1);

    // The already-resolved row did NOT get a new event.
    const db = getDb();
    const resolvedEvents = await db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, idResolved));
    // No new 'declined' event on the already-accepted row.
    expect(resolvedEvents.some(e => e.type === 'declined')).toBe(false);
  });

  it('non-recipient decline returns not-found for each id (existence-leak protection, no events)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    const intruder = await createTestUser();
    fixtures.push(proposer, recipient, intruder);

    const id1 = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    const id2 = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id1, id2);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(intruder.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { ids: [id1, id2], action: 'decline' },
    });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot, sleep: instantSleep });

    expect(res._status).toBe(200);
    const body = res._json as {
      results: Array<{ id: string; outcome: string }>;
      okCount: number;
      notificationsSent: number;
    };
    expect(body.okCount).toBe(0);
    expect(body.notificationsSent).toBe(0);
    for (const r of body.results) expect(r.outcome).toBe('not-found');

    // No side effects. Trades still pending.
    expect(bot.editCalls).toHaveLength(0);
    expect(bot.sendCalls).toHaveLength(0);
    const db = getDb();
    for (const id of [id1, id2]) {
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
      expect(row.status).toBe('pending');
    }
    // And no events were recorded.
    const events = await db.select().from(proposalEvents);
    const declined = events.filter(e => e.type === 'declined' && [id1, id2].includes(e.proposalId));
    expect(declined).toHaveLength(0);
  });

  it('non-proposer cancel returns forbidden for each id', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id1 = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id1);

    // Recipient tries to cancel a proposal sent to them — only the
    // proposer can cancel.
    const bot = makeFakeBot();
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { ids: [id1], action: 'cancel' },
    });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot, sleep: instantSleep });

    expect(res._status).toBe(200);
    const body = res._json as { results: Array<{ id: string; outcome: string }>; okCount: number };
    expect(body.results[0].outcome).toBe('forbidden');
    expect(body.okCount).toBe(0);

    // Trade unchanged.
    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id1)).limit(1);
    expect(row.status).toBe('pending');
  });

  it('bot failure on 2nd edit does not block the rest of the batch — transitions still commit', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id1 = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    const id2 = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    const id3 = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id1, id2, id3);

    const bot = makeFakeBot({ failEditOnNth: 2 });
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { ids: [id1, id2, id3], action: 'decline' },
    });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot, sleep: instantSleep });

    expect(res._status).toBe(200);
    const body = res._json as {
      results: Array<{ id: string; outcome: string }>;
      okCount: number;
      notificationsSent: number;
    };
    expect(body.okCount).toBe(3);

    // All 3 transitions committed, including the one whose DM edit
    // threw. Event log too.
    const db = getDb();
    for (const id of [id1, id2, id3]) {
      const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
      expect(row.status).toBe('declined');
    }
    const events = await db.select().from(proposalEvents);
    const declined = events.filter(e => e.type === 'declined' && [id1, id2, id3].includes(e.proposalId));
    expect(declined).toHaveLength(3);

    // All 3 edit attempts fired (the 2nd threw, but the loop kept going).
    expect(bot.editCalls).toHaveLength(3);
    // Summary DM still sent to the one proposer.
    expect(bot.sendCalls).toHaveLength(1);
  });

  it('coalescing: 5 declines to the same proposer → exactly 1 summary DM with declinedCount of 5', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
      ids.push(id);
      createdIds.push(id);
    }

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { ids, action: 'decline' },
    });
    const res = mockResponse();
    await handleBulkResolve(req, res, { bot, sleep: instantSleep });

    expect(res._status).toBe(200);
    const body = res._json as {
      results: Array<{ id: string; outcome: string }>;
      okCount: number;
      notificationsSent: number;
    };
    expect(body.okCount).toBe(5);
    expect(body.notificationsSent).toBe(1);

    // One DM, to the single proposer, titled "5 of your proposals were declined".
    expect(bot.sendCalls).toHaveLength(1);
    expect(bot.sendCalls[0].userId).toBe(proposer.id);
    expect(bot.sendCalls[0].body.embeds?.[0].title).toMatch(/5 of your proposals were declined/);
  });
});
