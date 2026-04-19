import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import { handleEdit } from '../../api/trades.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeProposals, proposalEvents, type TradeCardSnapshot } from '../../lib/schema.js';
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type EditCall } from './discordFakes.js';

function snapshot(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1.0 };
}

function makeFakeBot(editFails = false): DiscordBotClient & { editCalls: EditCall[] } {
  const editCalls: EditCall[] = [];
  return Object.assign(
    createBaseFakeBot({
      async editChannelMessage(channelId, messageId, body) {
        if (editFails) throw new Error('simulated discord failure');
        editCalls.push({ channelId, messageId, body });
      },
      async createDmChannel() { return { id: 'dm-edit' }; },
    }),
    { editCalls },
  );
}

async function insertProposal(overrides: {
  proposerUserId: string;
  recipientUserId: string;
  status?: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'countered';
  respondedAt?: Date | null;
  message?: string | null;
  discordDmChannelId?: string | null;
  discordDmMessageId?: string | null;
  offeringCards?: TradeCardSnapshot[];
  receivingCards?: TradeCardSnapshot[];
}): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb();
  await db.insert(tradeProposals).values({
    id,
    proposerUserId: overrides.proposerUserId,
    recipientUserId: overrides.recipientUserId,
    status: overrides.status ?? 'pending',
    offeringCards: overrides.offeringCards ?? [snapshot('p-1', 2)],
    receivingCards: overrides.receivingCards ?? [snapshot('p-2', 1)],
    message: overrides.message ?? null,
    deliveryStatus: 'delivered',
    discordDmChannelId: overrides.discordDmChannelId ?? 'dm-x',
    discordDmMessageId: overrides.discordDmMessageId ?? 'msg-x',
    ...(overrides.respondedAt !== undefined ? { respondedAt: overrides.respondedAt } : {}),
  });
  return id;
}

describeWithDb('POST /api/trades/edit', () => {
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

  it('proposer edits pending proposal; row updated, DM re-rendered, edited event recorded', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id = await insertProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      message: 'original message',
      offeringCards: [snapshot('old-offer', 1)],
      receivingCards: [snapshot('old-receive', 1)],
    });
    createdIds.push(id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(proposer.id);
    const newOffering = [snapshot('new-offer', 3)];
    const newReceiving = [snapshot('new-receive', 2)];
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        id,
        offeringCards: newOffering,
        receivingCards: newReceiving,
        message: 'updated message',
      },
    });
    const res = mockResponse();
    await handleEdit(req, res, { bot });

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ id, status: 'pending' });

    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
    expect(row.status).toBe('pending');
    expect(row.respondedAt).toBeNull();
    expect(row.message).toBe('updated message');
    expect(row.offeringCards).toEqual(newOffering);
    expect(row.receivingCards).toEqual(newReceiving);

    // DM edit happened with Accept/Counter/Decline buttons intact.
    expect(bot.editCalls).toHaveLength(1);
    const body = bot.editCalls[0].body;
    expect(body.components?.[0]).toMatchObject({
      components: expect.arrayContaining([
        expect.objectContaining({ label: 'Accept' }),
        expect.objectContaining({ label: 'Counter' }),
        expect.objectContaining({ label: 'Decline' }),
      ]),
    });

    // Event recorded with cardsChanged + messageChanged both true.
    const events = await db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, id))
      .orderBy(asc(proposalEvents.createdAt));
    const editedEvent = events.find(e => e.type === 'edited');
    expect(editedEvent).toBeDefined();
    expect(editedEvent?.actorUserId).toBe(proposer.id);
    expect(editedEvent?.payload).toEqual({ cardsChanged: true, messageChanged: true });
  });

  it('403 when a non-proposer attempts to edit; no mutation, no event', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const originalMessage = 'original';
    const id = await insertProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      message: originalMessage,
    });
    createdIds.push(id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        id,
        offeringCards: [snapshot('hack', 9)],
        receivingCards: [snapshot('hack-2', 9)],
        message: 'attacker message',
      },
    });
    const res = mockResponse();
    await handleEdit(req, res, { bot });

    expect(res._status).toBe(403);
    expect(bot.editCalls).toHaveLength(0);

    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
    expect(row.message).toBe(originalMessage);

    const events = await db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, id));
    expect(events.find(e => e.type === 'edited')).toBeUndefined();
  });

  it.each(['accepted', 'declined', 'cancelled', 'countered'] as const)(
    '409 when the proposal is already %s (non-pending)',
    async (status) => {
      const proposer = await createTestUser();
      const recipient = await createTestUser();
      fixtures.push(proposer, recipient);

      const id = await insertProposal({
        proposerUserId: proposer.id,
        recipientUserId: recipient.id,
        status,
        respondedAt: status === 'countered' ? new Date() : null,
      });
      createdIds.push(id);

      const bot = makeFakeBot();
      const cookie = await sealTestCookie(proposer.id);
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
        body: {
          id,
          offeringCards: [snapshot('x', 1)],
          receivingCards: [snapshot('y', 1)],
        },
      });
      const res = mockResponse();
      await handleEdit(req, res, { bot });

      expect(res._status).toBe(409);
      expect(bot.editCalls).toHaveLength(0);
    },
  );

  it('Discord edit failure still commits the DB update + event; caller gets 200', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id = await insertProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      message: 'before',
    });
    createdIds.push(id);

    const bot = makeFakeBot(/* editFails */ true);
    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        id,
        offeringCards: [snapshot('offer-after', 1)],
        receivingCards: [snapshot('receive-after', 1)],
        message: 'after',
      },
    });
    const res = mockResponse();
    await handleEdit(req, res, { bot });

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ id, status: 'pending' });

    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
    expect(row.message).toBe('after');

    const events = await db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, id));
    expect(events.find(e => e.type === 'edited')).toBeDefined();
  });

  it('400 when both sides are empty', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id = await insertProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
    });
    createdIds.push(id);

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        id,
        offeringCards: [],
        receivingCards: [],
      },
    });
    const res = mockResponse();
    await handleEdit(req, res, { bot: makeFakeBot() });

    expect(res._status).toBe(400);
  });
});
