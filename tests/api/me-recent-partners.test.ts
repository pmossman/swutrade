import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleRecentPartners } from '../../api/me.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeProposals, type TradeCardSnapshot } from '../../lib/schema.js';

function snapshot(productId: string): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty: 1, unitPrice: 1 };
}

async function insertProposal(args: {
  proposerUserId: string;
  recipientUserId: string;
  updatedAt: Date;
}): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb();
  await db.insert(tradeProposals).values({
    id,
    proposerUserId: args.proposerUserId,
    recipientUserId: args.recipientUserId,
    status: 'pending',
    offeringCards: [snapshot('p-1')],
    receivingCards: [snapshot('p-2')],
    deliveryStatus: 'delivered',
    discordDmChannelId: 'dm-x',
    discordDmMessageId: 'msg-x',
    updatedAt: args.updatedAt,
  });
  return id;
}

/**
 * Covers the recent-partners endpoint that powers HandlePickerDialog's
 * "Recent" chips row. Gates: distinct counterpart dedupe, newest-first
 * ordering, cap at 5, empty-array for new users.
 */
describeWithDb('GET /api/me/recent-partners', () => {
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

  it('returns distinct counterparties ordered by most-recent interaction', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const carol = await createTestUser();
    fixtures.push(carol);

    const now = Date.now();
    // Chronology: carol (oldest) → alice → bob → alice again (newest).
    // Viewer is recipient in one, proposer in the rest — dedupe must
    // treat both sides as the same "interaction with this person."
    createdIds.push(await insertProposal({
      proposerUserId: viewer.id,
      recipientUserId: carol.id,
      updatedAt: new Date(now - 4000),
    }));
    createdIds.push(await insertProposal({
      proposerUserId: alice.id,
      recipientUserId: viewer.id,
      updatedAt: new Date(now - 3000),
    }));
    createdIds.push(await insertProposal({
      proposerUserId: viewer.id,
      recipientUserId: bob.id,
      updatedAt: new Date(now - 2000),
    }));
    createdIds.push(await insertProposal({
      proposerUserId: viewer.id,
      recipientUserId: alice.id,
      updatedAt: new Date(now - 1000),
    }));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleRecentPartners(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { partners: Array<{ userId: string; handle: string }> };
    // Alice (most recent), Bob, Carol. Viewer never appears in their own list.
    expect(body.partners.map(p => p.userId)).toEqual([alice.id, bob.id, carol.id]);
  });

  it('caps the response at 5 partners', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const others = [];
    for (let i = 0; i < 7; i++) {
      const u = await createTestUser();
      others.push(u);
      fixtures.push(u);
    }

    const now = Date.now();
    for (let i = 0; i < others.length; i++) {
      createdIds.push(await insertProposal({
        proposerUserId: viewer.id,
        recipientUserId: others[i].id,
        updatedAt: new Date(now - i * 1000),
      }));
    }

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleRecentPartners(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { partners: unknown[] };
    expect(body.partners).toHaveLength(5);
  });

  it('returns an empty array when the viewer has never proposed or received', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleRecentPartners(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { partners: unknown[] };
    expect(body.partners).toEqual([]);
  });
});
