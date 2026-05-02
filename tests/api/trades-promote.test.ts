import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handlePromoteToShared } from '../../api/trades.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import {
  proposalEvents,
  sessionEvents,
  tradeProposals,
  tradeSessions,
  type TradeCardSnapshot,
} from '../../lib/schema.js';
import { normalizeParticipants } from '../../lib/sessions.js';

/**
 * Phase 5b sliver 6 — proposal → session promotion.
 *
 * The recipient of a pending proposal taps "Edit together" and the
 * web surface POSTs `/api/trades/promote-to-shared` with the proposal
 * id. The handler creates a new shared session seeded with the
 * proposal's cards, transitions the proposal to `countered`, logs
 * events on both sides, and redirects the viewer into `/s/<code>`.
 *
 * Covers the 5 required paths:
 *   - happy path (recipient, pending proposal)
 *   - 403 for proposer attempting to promote
 *   - 409 for already-resolved proposal
 *   - 404 for unknown proposal id
 *   - 200 + created=false when the pair already has an active session
 */

function snapshot(productId: string, qty = 1, unitPrice = 1.0): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice };
}

async function seedProposal(overrides: {
  proposerUserId: string;
  recipientUserId: string;
  status?: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'countered';
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
    message: null,
    deliveryStatus: 'delivered',
    discordDmChannelId: 'dm-promote-x',
    discordDmMessageId: 'msg-promote-x',
  });
  return id;
}

describeWithDb('POST /api/trades?action=promote-to-shared', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdProposalIds: string[] = [];
  const createdSessionIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdSessionIds) {
      await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, id)).catch(() => {});
      await db.delete(tradeSessions).where(eq(tradeSessions.id, id)).catch(() => {});
    }
    createdSessionIds.length = 0;
    for (const id of createdProposalIds) {
      await db.delete(proposalEvents).where(eq(proposalEvents.proposalId, id)).catch(() => {});
      await db.delete(tradeProposals).where(eq(tradeProposals.id, id)).catch(() => {});
    }
    createdProposalIds.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('happy path: recipient promotes a pending proposal → session created with both parties + cards, proposal goes to countered', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const offering = [snapshot('prop-o-1', 2), snapshot('prop-o-2', 1)];
    const receiving = [snapshot('prop-r-1', 3)];
    const proposalId = await seedProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      offeringCards: offering,
      receivingCards: receiving,
    });
    createdProposalIds.push(proposalId);

    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { proposalId },
    });
    const res = mockResponse();
    await handlePromoteToShared(req, res);

    expect(res._status).toBe(201);
    const body = res._json as { sessionId: string; created: boolean };
    expect(body.created).toBe(true);
    expect(body.sessionId).toBeTruthy();
    createdSessionIds.push(body.sessionId);

    const db = getDb();

    // Session row: both parties sit in canonical a/b order, cards
    // travel with the proposer (offering) vs recipient (receiving).
    const [sessionRow] = await db
      .select()
      .from(tradeSessions)
      .where(eq(tradeSessions.id, body.sessionId))
      .limit(1);
    expect(sessionRow).toBeTruthy();
    expect(sessionRow.status).toBe('active');
    const { userAId, userBId } = normalizeParticipants(proposer.id, recipient.id);
    expect(sessionRow.userAId).toBe(userAId);
    expect(sessionRow.userBId).toBe(userBId);
    // Proposer's offering lives on the proposer's slot; recipient's
    // slot carries what the proposer wanted from them.
    const proposerIsA = sessionRow.userAId === proposer.id;
    const proposerCards = proposerIsA ? sessionRow.userACards : sessionRow.userBCards;
    const recipientCards = proposerIsA ? sessionRow.userBCards : sessionRow.userACards;
    expect(proposerCards.map(c => c.productId).sort()).toEqual(['prop-o-1', 'prop-o-2']);
    expect(recipientCards.map(c => c.productId)).toEqual(['prop-r-1']);
    expect(sessionRow.lastEditedByUserId).toBe(recipient.id);
    expect(sessionRow.confirmedByUserIds).toEqual([]);

    // Proposal row flips to `promoted` with respondedAt set.
    const [proposalRow] = await db
      .select()
      .from(tradeProposals)
      .where(eq(tradeProposals.id, proposalId))
      .limit(1);
    expect(proposalRow.status).toBe('promoted');
    expect(proposalRow.respondedAt).not.toBeNull();

    // Session event carries the promotedFromProposalId pointer.
    const sEvents = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, body.sessionId));
    const created = sEvents.find(e => e.type === 'created');
    expect(created).toBeTruthy();
    expect(created?.actorUserId).toBe(recipient.id);
    expect(created?.payload).toMatchObject({ promotedFromProposalId: proposalId });

    // Proposal event carries the promotedToSessionId pointer.
    const pEvents = await db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, proposalId));
    const promoted = pEvents.find(e => e.type === 'promoted');
    expect(promoted).toBeTruthy();
    expect(promoted?.actorUserId).toBe(recipient.id);
    expect(promoted?.payload).toMatchObject({ promotedToSessionId: body.sessionId });
  });

  it('403 when the proposer tries to promote their own proposal', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const proposalId = await seedProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
    });
    createdProposalIds.push(proposalId);

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { proposalId },
    });
    const res = mockResponse();
    await handlePromoteToShared(req, res);

    expect(res._status).toBe(403);

    // Proposal unchanged; no session created.
    const db = getDb();
    const [row] = await db
      .select()
      .from(tradeProposals)
      .where(eq(tradeProposals.id, proposalId))
      .limit(1);
    expect(row.status).toBe('pending');
  });

  it('409 when the proposal is already resolved (e.g. accepted)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const proposalId = await seedProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'accepted',
    });
    createdProposalIds.push(proposalId);

    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { proposalId },
    });
    const res = mockResponse();
    await handlePromoteToShared(req, res);

    expect(res._status).toBe(409);
    const body = res._json as { error: string };
    expect(body.error).toMatch(/no longer pending/i);

    // No session should have been created.
    const db = getDb();
    const rows = await db.select().from(tradeSessions);
    const promotedFor = rows.filter(r => r.userAId === proposer.id || r.userAId === recipient.id || r.userBId === proposer.id || r.userBId === recipient.id);
    expect(promotedFor).toHaveLength(0);
  });

  it("404 when the proposal doesn't exist", async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { proposalId: '00000000-0000-0000-0000-000000000000' },
    });
    const res = mockResponse();
    await handlePromoteToShared(req, res);

    expect(res._status).toBe(404);
  });

  it('200 + created=false when the pair already has an active session — caller redirects into the existing canvas', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    // Seed an existing active session between the two users directly
    // — this simulates the "forgot about an in-progress canvas, then
    // a proposal landed, now I want to merge into the canvas" case.
    const { userAId, userBId } = normalizeParticipants(proposer.id, recipient.id);
    const existingSessionId = `EXISTING1`;
    const db = getDb();
    await db.insert(tradeSessions).values({
      id: existingSessionId,
      userAId,
      userBId,
      userACards: [],
      userBCards: [],
      status: 'active',
      confirmedByUserIds: [],
      lastNotifiedAt: {},
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    createdSessionIds.push(existingSessionId);

    // And a pending proposal between the same two users.
    const proposalId = await seedProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
    });
    createdProposalIds.push(proposalId);

    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { proposalId },
    });
    const res = mockResponse();
    await handlePromoteToShared(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { sessionId: string; created: boolean };
    expect(body.created).toBe(false);
    expect(body.sessionId).toBe(existingSessionId);

    // Proposal still pending — we deliberately did NOT transition it
    // when redirecting into an existing canvas. The recipient can
    // still accept/decline/counter from their end, or the canvas can
    // supersede it via its own settle flow.
    const [proposalRow] = await db
      .select()
      .from(tradeProposals)
      .where(eq(tradeProposals.id, proposalId))
      .limit(1);
    expect(proposalRow.status).toBe('pending');
  });
});
