import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { handleNudge } from '../../api/trades.js';
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
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type PostCall, type SendCall } from './discordFakes.js';

/**
 * Covers POST /api/trades/nudge — the proposer-only "bump a pending
 * proposal" path. The endpoint re-posts a fresh Discord message
 * (new DM or new thread message) so the recipient gets a push
 * notification; crucially the proposal row itself is left alone.
 *
 * Contract locks:
 *   - only the proposer can nudge (403 for anyone else)
 *   - only pending proposals can be nudged (409 otherwise)
 *   - 24h cooldown enforced via lastNudgedAt (429 inside window)
 *   - event is recorded even when Discord delivery fails (so the
 *     cooldown is honest regardless of transport outcome)
 *   - thread-backed proposals post to the thread, not a DM
 */

function snapshot(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1.0 };
}

type FakeBot = DiscordBotClient & {
  sendCalls: SendCall[];
  postCalls: PostCall[];
};

function makeFakeBot(opts: { shouldFail?: boolean } = {}): FakeBot {
  const sendCalls: SendCall[] = [];
  const postCalls: PostCall[] = [];
  return Object.assign(
    createBaseFakeBot({
      async postChannelMessage(channelId, body) {
        postCalls.push({ channelId, body });
        if (opts.shouldFail) throw new Error('simulated post failure');
        return { id: 'thread-msg-nudge', channel_id: channelId };
      },
      async createDmChannel() { return { id: 'dm-nudge' }; },
      async sendDirectMessage(userId, body) {
        sendCalls.push({ userId, body });
        if (opts.shouldFail) throw new Error('simulated send failure');
        return { id: 'msg-nudge', channel_id: 'dm-nudge' };
      },
    }),
    { sendCalls, postCalls },
  );
}

async function insertProposal(overrides: {
  proposerUserId: string;
  recipientUserId: string;
  status?: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'countered';
  discordThreadId?: string | null;
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
    discordDmChannelId: overrides.discordThreadId ?? 'dm-x',
    discordDmMessageId: 'msg-x',
    discordThreadId: overrides.discordThreadId ?? null,
    discordThreadParentChannelId: overrides.discordThreadId ? 'parent-ch-1' : null,
  });
  return id;
}

describeWithDb('POST /api/trades/nudge', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    // Events cascade on proposal delete, but clean explicitly first
    // in case a test inserted events referencing a proposal we're
    // about to remove (order matters under cascade='cascade').
    for (const id of createdIds) {
      await db.delete(proposalEvents).where(eq(proposalEvents.proposalId, id)).catch(() => {});
      await db.delete(tradeProposals).where(eq(tradeProposals.id, id)).catch(() => {});
    }
    createdIds.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('happy path: re-sends DM, records nudged event with note payload', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const id = await insertProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id, note: 'still interested?' },
    });
    const res = mockResponse();
    await handleNudge(req, res, { bot });

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ id });
    expect((res._json as { nudgedAt: string }).nudgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // DM went out (not thread — thread id is null on this row).
    expect(bot.sendCalls).toHaveLength(1);
    expect(bot.postCalls).toHaveLength(0);
    expect(bot.sendCalls[0].userId).toBe(recipient.id);

    // Row state unchanged — nudge is a notification, not a mutation.
    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
    expect(row.status).toBe('pending');
    expect(row.deliveryStatus).toBe('delivered');

    // Event was recorded with the note payload.
    const events = await db
      .select()
      .from(proposalEvents)
      .where(and(eq(proposalEvents.proposalId, id), eq(proposalEvents.type, 'nudged')));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ note: 'still interested?' });
  });

  it('403 when the viewer is the recipient, not the proposer', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const id = await insertProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleNudge(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(403);
  });

  it('409 when the proposal is not pending (accepted)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const id = await insertProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'accepted',
    });
    createdIds.push(id);

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleNudge(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(409);
  });

  it('429 with nextAvailableAt on a second nudge within 24h', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const id = await insertProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const cookie = await sealTestCookie(proposer.id);
    const firstReq = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id, note: 'first' },
    });
    const firstRes = mockResponse();
    await handleNudge(firstReq, firstRes, { bot: makeFakeBot() });
    expect(firstRes._status).toBe(200);

    const secondReq = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id, note: 'second' },
    });
    const secondRes = mockResponse();
    await handleNudge(secondReq, secondRes, { bot: makeFakeBot() });
    expect(secondRes._status).toBe(429);
    const body = secondRes._json as { error: string; nextAvailableAt: string; detail: string };
    expect(body.error).toBe('rate-limited');
    expect(body.nextAvailableAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The nextAvailableAt timestamp must be in the future.
    expect(new Date(body.nextAvailableAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.detail).toMatch(/try again after/);
  });

  it('no note: still 200, payload.note is null', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const id = await insertProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleNudge(req, res, { bot });
    expect(res._status).toBe(200);

    const db = getDb();
    const events = await db
      .select()
      .from(proposalEvents)
      .where(and(eq(proposalEvents.proposalId, id), eq(proposalEvents.type, 'nudged')));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ note: null });
  });

  it('bot re-post failure still records event and returns 200', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const id = await insertProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const bot = makeFakeBot({ shouldFail: true });
    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id, note: 'ping' },
    });
    const res = mockResponse();
    await handleNudge(req, res, { bot });
    expect(res._status).toBe(200);

    const db = getDb();
    const events = await db
      .select()
      .from(proposalEvents)
      .where(and(eq(proposalEvents.proposalId, id), eq(proposalEvents.type, 'nudged')));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ note: 'ping' });
    // And a second nudge is now rate-limited on the failed first attempt —
    // the event log is the source of truth, not transport success.
    const retryReq = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const retryRes = mockResponse();
    await handleNudge(retryReq, retryRes, { bot: makeFakeBot() });
    expect(retryRes._status).toBe(429);
  });

  it('thread-backed proposal posts to thread, not DM', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const id = await insertProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      discordThreadId: 'thread-xyz',
    });
    createdIds.push(id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id, note: 'bump' },
    });
    const res = mockResponse();
    await handleNudge(req, res, { bot });
    expect(res._status).toBe(200);

    expect(bot.postCalls).toHaveLength(1);
    expect(bot.postCalls[0].channelId).toBe('thread-xyz');
    expect(bot.sendCalls).toHaveLength(0);
  });
});
