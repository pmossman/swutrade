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
    await handlePropose(req, res);

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
    await handlePropose(req, res);
    expect(res._status).toBe(401);
  });

  it('405s on non-POST', async () => {
    const proposer = await createTestUser();
    fixtures.push(proposer);
    const cookie = await sealTestCookie(proposer.id);

    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handlePropose(req, res);
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
    await handlePropose(req, res);
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
    await handlePropose(req, res);
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
    await handlePropose(req, res);
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
    await handlePropose(req, res);
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
    await handlePropose(req, res);
    expect(res._status).toBe(404);
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
    await handlePropose(req, res);
    expect(res._status).toBe(400);
  });
});
