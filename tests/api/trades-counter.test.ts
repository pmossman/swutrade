import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleCounter, handleGetProposal } from '../../api/trades.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeProposals, type TradeCardSnapshot } from '../../lib/schema.js';
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type EditCall, type SendCall } from './discordFakes.js';

/**
 * Covers POST /api/trades/counter — the recipient-initiated counter
 * flow. Locks the transition semantics (original → 'countered', new
 * row with counter_of_id set + flipped sides), the auth gate (only
 * the original recipient can counter), and the race guard (409 when
 * another action resolves the original between read and write).
 *
 * DM side-effects are exercised via an injected fake bot so we can
 * assert the edit-original + send-counter call pattern without
 * hitting Discord.
 */
describeWithDb('POST /api/trades/counter', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdIds) {
      await db.delete(tradeProposals).where(eq(tradeProposals.id, id)).catch(() => {});
    }
    createdIds.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  function snapshot(productId: string, qty = 1): TradeCardSnapshot {
    return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1.0 };
  }

  function makeFakeBot(opts: { editFails?: boolean; sendFails?: boolean } = {}): DiscordBotClient & {
    editCalls: EditCall[];
    sendCalls: SendCall[];
  } {
    const editCalls: EditCall[] = [];
    const sendCalls: SendCall[] = [];
    return Object.assign(
      createBaseFakeBot({
        async editChannelMessage(channelId, messageId, body) {
          editCalls.push({ channelId, messageId, body });
          if (opts.editFails) throw new Error('simulated edit failure');
        },
        async createDmChannel() { return { id: 'dm-counter' }; },
        async sendDirectMessage(userId, body) {
          sendCalls.push({ userId, body });
          if (opts.sendFails) throw new Error('simulated send failure');
          return { id: 'counter-msg-1', channel_id: 'dm-counter' };
        },
      }),
      { editCalls, sendCalls },
    );
  }

  async function seedOriginal(overrides: {
    proposerUserId: string;
    recipientUserId: string;
    status?: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'countered';
    discordDmChannelId?: string | null;
    discordDmMessageId?: string | null;
  }) {
    const id = crypto.randomUUID();
    createdIds.push(id);
    const db = getDb();
    await db.insert(tradeProposals).values({
      id,
      proposerUserId: overrides.proposerUserId,
      recipientUserId: overrides.recipientUserId,
      status: overrides.status ?? 'pending',
      offeringCards: [snapshot('orig-offer-1')],
      receivingCards: [snapshot('orig-receive-1')],
      message: null,
      deliveryStatus: 'delivered',
      discordDmChannelId: overrides.discordDmChannelId ?? 'dm-orig',
      discordDmMessageId: overrides.discordDmMessageId ?? 'msg-orig',
    });
    return id;
  }

  it('happy path: creates counter row + transitions original to countered + edits + sends DM', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const originalId = await seedOriginal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
    });

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        counterOfId: originalId,
        offeringCards: [snapshot('counter-offer-1', 2)],
        receivingCards: [snapshot('counter-receive-1')],
        message: 'how about this instead?',
      },
    });
    const res = mockResponse();
    await handleCounter(req, res, { bot });

    expect(res._status).toBe(201);
    const body = res._json as { id: string; deliveryStatus: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.deliveryStatus).toBe('delivered');
    createdIds.push(body.id);

    const db = getDb();
    // Original is now countered.
    const [origRow] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, originalId)).limit(1);
    expect(origRow.status).toBe('countered');
    expect(origRow.respondedAt).not.toBeNull();

    // Counter row wires proposer/recipient correctly (flipped) +
    // carries the self-FK back to the original.
    const [counterRow] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, body.id)).limit(1);
    expect(counterRow.proposerUserId).toBe(recipient.id);
    expect(counterRow.recipientUserId).toBe(proposer.id);
    expect(counterRow.counterOfId).toBe(originalId);
    expect(counterRow.status).toBe('pending');
    expect(counterRow.message).toBe('how about this instead?');
    expect(counterRow.offeringCards[0].productId).toBe('counter-offer-1');

    // Original's DM was edited.
    expect(bot.editCalls).toHaveLength(1);
    expect(bot.editCalls[0].messageId).toBe('msg-orig');
    expect(bot.editCalls[0].body.components).toEqual([]);

    // New counter DM was sent to the ORIGINAL proposer (recipient
    // of the counter = original's proposer).
    expect(bot.sendCalls).toHaveLength(1);
    expect(bot.sendCalls[0].userId).toBe(proposer.id);
    expect(bot.sendCalls[0].body.embeds?.[0].title).toContain('Counter');
  });

  it('401 when unauthenticated', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const originalId = await seedOriginal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
    });

    const req = mockRequest({
      method: 'POST',
      body: {
        counterOfId: originalId,
        offeringCards: [snapshot('x')],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handleCounter(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(401);
  });

  it('405 on non-POST', async () => {
    const user = await createTestUser();
    fixtures.push(user);
    const cookie = await sealTestCookie(user.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleCounter(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(405);
  });

  it('403 when the viewer is not the original recipient', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    const intruder = await createTestUser();
    fixtures.push(proposer, recipient, intruder);
    const originalId = await seedOriginal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
    });

    const cookie = await sealTestCookie(intruder.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        counterOfId: originalId,
        offeringCards: [snapshot('x')],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handleCounter(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(403);
  });

  it('404 when the referenced trade does not exist', async () => {
    const user = await createTestUser();
    fixtures.push(user);
    const cookie = await sealTestCookie(user.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        counterOfId: '00000000-0000-0000-0000-000000000000',
        offeringCards: [snapshot('x')],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handleCounter(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(404);
  });

  it('409 when the original is no longer pending (already accepted)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const originalId = await seedOriginal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'accepted',
    });

    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        counterOfId: originalId,
        offeringCards: [snapshot('x')],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handleCounter(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(409);
    expect(res._json).toMatchObject({ error: 'already-resolved' });

    // No counter row was created.
    const db = getDb();
    const rows = await db.select().from(tradeProposals).where(eq(tradeProposals.counterOfId, originalId));
    expect(rows).toHaveLength(0);
  });

  it('counter row survives edit/send DM failures (delivery_status reflects the send outcome)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const originalId = await seedOriginal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
    });

    const bot = makeFakeBot({ editFails: true, sendFails: true });
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        counterOfId: originalId,
        offeringCards: [snapshot('x')],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handleCounter(req, res, { bot });

    // Still 201 — the proposal lifecycle is more important than
    // Discord's transport working on every call.
    expect(res._status).toBe(201);
    expect(res._json).toMatchObject({ deliveryStatus: 'failed' });
    const newId = (res._json as { id: string }).id;
    createdIds.push(newId);

    const db = getDb();
    const [origRow] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, originalId)).limit(1);
    expect(origRow.status).toBe('countered');
    const [counterRow] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, newId)).limit(1);
    expect(counterRow.deliveryStatus).toBe('failed');
    expect(counterRow.discordDmMessageId).toBeNull();
  });

  it('400 on empty card payload (both sides empty fails the refine)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const originalId = await seedOriginal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
    });

    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        counterOfId: originalId,
        offeringCards: [],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handleCounter(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(400);
  });
});

describeWithDb('GET /api/trades/:id', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdIds) {
      await db.delete(tradeProposals).where(eq(tradeProposals.id, id)).catch(() => {});
    }
    createdIds.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('returns the trade for the proposer', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const id = crypto.randomUUID();
    createdIds.push(id);
    const db = getDb();
    await db.insert(tradeProposals).values({
      id,
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'pending',
      offeringCards: [{ productId: 'p', name: 'P', variant: 'Standard', qty: 1, unitPrice: 1 }],
      receivingCards: [],
      message: null,
    });

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie }, query: { id } });
    const res = mockResponse();
    await handleGetProposal(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      id,
      status: 'pending',
      viewerIsProposer: true,
      viewerIsRecipient: false,
    });
  });

  it('404s for non-parties (no existence leak)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    const stranger = await createTestUser();
    fixtures.push(proposer, recipient, stranger);
    const id = crypto.randomUUID();
    createdIds.push(id);
    const db = getDb();
    await db.insert(tradeProposals).values({
      id,
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'pending',
      offeringCards: [{ productId: 'p', name: 'P', variant: 'Standard', qty: 1, unitPrice: 1 }],
      receivingCards: [],
      message: null,
    });

    const cookie = await sealTestCookie(stranger.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie }, query: { id } });
    const res = mockResponse();
    await handleGetProposal(req, res);

    expect(res._status).toBe(404);
  });

  it('401 when unauthenticated', async () => {
    const req = mockRequest({ method: 'GET', query: { id: 'anything' } });
    const res = mockResponse();
    await handleGetProposal(req, res);
    expect(res._status).toBe(401);
  });
});
