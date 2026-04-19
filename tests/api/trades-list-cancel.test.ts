import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleProposalsList,
  handleCancel,
  handleGetProposal,
} from '../../api/trades.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeProposals, proposalEvents, type TradeCardSnapshot } from '../../lib/schema.js';
import { recordEvent } from '../../lib/proposalEvents.js';
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type EditCall } from './discordFakes.js';

function snapshot(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1.0 };
}

function makeFakeBot(): DiscordBotClient & { editCalls: EditCall[] } {
  const editCalls: EditCall[] = [];
  return Object.assign(
    createBaseFakeBot({
      async editChannelMessage(channelId, messageId, body) {
        editCalls.push({ channelId, messageId, body });
      },
      async createDmChannel() { return { id: 'dm-cancel' }; },
    }),
    { editCalls },
  );
}

async function insertProposal(overrides: {
  proposerUserId: string;
  recipientUserId: string;
  status?: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'countered';
  counterOfId?: string | null;
  updatedAt?: Date;
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
    counterOfId: overrides.counterOfId ?? null,
    offeringCards: [snapshot('p-1', 2)],
    receivingCards: [snapshot('p-2', 1)],
    message: null,
    deliveryStatus: 'delivered',
    discordDmChannelId: overrides.discordDmChannelId ?? 'dm-x',
    discordDmMessageId: overrides.discordDmMessageId ?? 'msg-x',
    ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
  });
  return id;
}

describeWithDb('GET /api/trades/proposals', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    // Event rows FK-cascade from proposals, but delete them first
    // explicitly so failed inserts don't linger if a proposal row
    // delete hits an error path above.
    for (const id of createdIds) {
      await db.delete(proposalEvents).where(eq(proposalEvents.proposalId, id)).catch(() => {});
      await db.delete(tradeProposals).where(eq(tradeProposals.id, id)).catch(() => {});
    }
    createdIds.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('401 when unauthenticated', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handleProposalsList(req, res);
    expect(res._status).toBe(401);
  });

  it('returns sent + received proposals with correct direction labels and counterparts', async () => {
    const viewer = await createTestUser();
    const alice = await createTestUser();
    const bob = await createTestUser();
    fixtures.push(viewer, alice, bob);

    const sentId = await insertProposal({ proposerUserId: viewer.id, recipientUserId: alice.id });
    const receivedId = await insertProposal({ proposerUserId: bob.id, recipientUserId: viewer.id });
    createdIds.push(sentId, receivedId);

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleProposalsList(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { proposals: Array<{
      id: string; direction: string; counterpart: { handle: string } | null;
    }> };
    const sent = body.proposals.find(p => p.id === sentId);
    const received = body.proposals.find(p => p.id === receivedId);
    expect(sent?.direction).toBe('sent');
    expect(sent?.counterpart?.handle).toBe(alice.handle);
    expect(received?.direction).toBe('received');
    expect(received?.counterpart?.handle).toBe(bob.handle);
  });

  it('orders by updatedAt desc (most-recently-active first)', async () => {
    const viewer = await createTestUser();
    const other = await createTestUser();
    fixtures.push(viewer, other);

    const older = await insertProposal({
      proposerUserId: viewer.id,
      recipientUserId: other.id,
      updatedAt: new Date(Date.now() - 10_000),
    });
    const newer = await insertProposal({
      proposerUserId: viewer.id,
      recipientUserId: other.id,
      updatedAt: new Date(Date.now() - 1_000),
    });
    createdIds.push(older, newer);

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleProposalsList(req, res);

    const ids = (res._json as { proposals: Array<{ id: string }> }).proposals.map(p => p.id);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
  });

  it('does not leak proposals from unrelated users', async () => {
    const viewer = await createTestUser();
    const alice = await createTestUser();
    const bob = await createTestUser();
    const eve = await createTestUser();
    fixtures.push(viewer, alice, bob, eve);

    // Proposal between alice and bob — viewer is not a party.
    const hidden = await insertProposal({ proposerUserId: alice.id, recipientUserId: bob.id });
    const mine = await insertProposal({ proposerUserId: viewer.id, recipientUserId: eve.id });
    createdIds.push(hidden, mine);

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleProposalsList(req, res);

    const ids = (res._json as { proposals: Array<{ id: string }> }).proposals.map(p => p.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(hidden);
  });

  it('recentActivity surfaces user-action events, skips creation + delivery noise, and includes counterpart handle', async () => {
    const viewer = await createTestUser();
    const alice = await createTestUser();
    fixtures.push(viewer, alice);

    const db = getDb();
    const mine = await insertProposal({ proposerUserId: viewer.id, recipientUserId: alice.id });
    createdIds.push(mine);

    // Mix of noisy + interesting events. Only the latter should
    // appear in recentActivity. All belong to a proposal the viewer
    // is party to, so they're all in scope for the query.
    await recordEvent(db, { proposalId: mine, actorUserId: viewer.id, type: 'created' });
    await recordEvent(db, { proposalId: mine, actorUserId: null, type: 'delivered_ok' });
    await recordEvent(db, { proposalId: mine, actorUserId: alice.id, type: 'accepted' });

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleProposalsList(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      recentActivity: Array<{
        type: string;
        actor: { handle: string } | null;
        proposalId: string;
        counterpartHandle: string | null;
      }>;
    };
    const types = body.recentActivity.map(e => e.type);
    expect(types).toContain('accepted');
    expect(types).not.toContain('created');
    expect(types).not.toContain('delivered_ok');

    const accepted = body.recentActivity.find(e => e.type === 'accepted');
    expect(accepted?.actor?.handle).toBe(alice.handle);
    expect(accepted?.proposalId).toBe(mine);
    // Counterpart from the viewer's perspective is alice (since
    // viewer is the proposer, recipient = alice).
    expect(accepted?.counterpartHandle).toBe(alice.handle);
  });

  it('recentActivity is scoped to proposals the viewer is party to (no leak)', async () => {
    const viewer = await createTestUser();
    const alice = await createTestUser();
    const bob = await createTestUser();
    fixtures.push(viewer, alice, bob);

    const db = getDb();
    const mine = await insertProposal({ proposerUserId: viewer.id, recipientUserId: alice.id });
    // Proposal between two other users — viewer should never see its events.
    const unrelated = await insertProposal({ proposerUserId: alice.id, recipientUserId: bob.id });
    createdIds.push(mine, unrelated);

    await recordEvent(db, { proposalId: mine, actorUserId: alice.id, type: 'nudged' });
    await recordEvent(db, { proposalId: unrelated, actorUserId: alice.id, type: 'accepted' });

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleProposalsList(req, res);

    const body = res._json as {
      recentActivity: Array<{ proposalId: string }>;
    };
    const proposalIds = body.recentActivity.map(e => e.proposalId);
    expect(proposalIds).toContain(mine);
    expect(proposalIds).not.toContain(unrelated);
  });

  it('recentActivity is capped at 5 entries, newest first', async () => {
    const viewer = await createTestUser();
    const alice = await createTestUser();
    fixtures.push(viewer, alice);

    const db = getDb();
    const p = await insertProposal({ proposerUserId: viewer.id, recipientUserId: alice.id });
    createdIds.push(p);

    // 7 events — cap at 5. Drizzle's default insert creates its own
    // timestamps in-order, so the last-inserted event is freshest.
    for (let i = 0; i < 7; i += 1) {
      await recordEvent(db, { proposalId: p, actorUserId: alice.id, type: 'nudged' });
    }

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleProposalsList(req, res);

    const body = res._json as { recentActivity: unknown[] };
    expect(body.recentActivity).toHaveLength(5);
  });
});

describeWithDb('POST /api/trades/cancel', () => {
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

  it('proposer cancels a pending proposal; status flips + DM gets edited', async () => {
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
    await handleCancel(req, res, { bot });

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'cancelled' });

    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
    expect(row.status).toBe('cancelled');
    expect(row.respondedAt).not.toBeNull();

    expect(bot.editCalls).toHaveLength(1);
    expect(bot.editCalls[0].body.components).toEqual([]);
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
    await handleCancel(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(403);
  });

  it('idempotent on already-cancelled (200 no-op, no DM edit)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);
    const id = await insertProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'cancelled',
    });
    createdIds.push(id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleCancel(req, res, { bot });

    expect(res._status).toBe(200);
    expect(bot.editCalls).toHaveLength(0);
  });

  it('409 when the proposal is already resolved (accepted)', async () => {
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
    await handleCancel(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(409);
  });

  it('404 for unknown trade id', async () => {
    const user = await createTestUser();
    fixtures.push(user);
    const cookie = await sealTestCookie(user.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id: '00000000-0000-0000-0000-000000000000' },
    });
    const res = mockResponse();
    await handleCancel(req, res, { bot: makeFakeBot() });
    expect(res._status).toBe(404);
  });
});

describeWithDb('GET /api/trades/:id — chain context stubs', () => {
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

  it('returns counteredByStub when this proposal has been countered', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const originalId = await insertProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'countered',
    });
    const counterId = await insertProposal({
      proposerUserId: recipient.id,
      recipientUserId: proposer.id,
      counterOfId: originalId,
    });
    createdIds.push(counterId, originalId); // delete child first (set-null FK)

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { id: originalId },
    });
    const res = mockResponse();
    await handleGetProposal(req, res);

    const body = res._json as {
      counterOfStub: unknown; counteredByStub: { id: string; status: string } | null;
    };
    expect(body.counterOfStub).toBeNull();
    expect(body.counteredByStub?.id).toBe(counterId);
  });

  it('returns counterOfStub when this proposal counters another', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const originalId = await insertProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'countered',
    });
    const counterId = await insertProposal({
      proposerUserId: recipient.id,
      recipientUserId: proposer.id,
      counterOfId: originalId,
    });
    createdIds.push(counterId, originalId);

    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { id: counterId },
    });
    const res = mockResponse();
    await handleGetProposal(req, res);

    const body = res._json as {
      counterOfStub: { id: string; status: string } | null; counteredByStub: unknown;
    };
    expect(body.counterOfStub?.id).toBe(originalId);
    expect(body.counterOfStub?.status).toBe('countered');
    expect(body.counteredByStub).toBeNull();
  });
});
