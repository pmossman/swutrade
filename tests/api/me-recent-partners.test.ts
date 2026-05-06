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
import { tradeSessions, type TradeCardSnapshot, type SessionStatus } from '../../lib/schema.js';

function snapshot(productId: string): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty: 1, unitPrice: 1 };
}

// `userAId` < `userBId` is the canonical ordering enforced at the
// table; mirror it here so the partial unique index over active
// sessions doesn't reject inserts from the seeded fixtures.
function canonicalPair(a: string, b: string): { userAId: string; userBId: string } {
  return a < b ? { userAId: a, userBId: b } : { userAId: b, userBId: a };
}

async function insertSession(args: {
  viewerId: string;
  counterpartId: string;
  updatedAt: Date;
  // Default `cancelled` so multiple sessions for the same pair don't
  // trip the partial unique index over `status='active'`. The endpoint
  // ignores status — it surfaces partners across the whole history.
  status?: SessionStatus;
}): Promise<string> {
  const id = crypto.randomUUID();
  const { userAId, userBId } = canonicalPair(args.viewerId, args.counterpartId);
  const db = getDb();
  await db.insert(tradeSessions).values({
    id,
    userAId,
    userBId,
    userACards: [snapshot('p-1')],
    userBCards: [snapshot('p-2')],
    status: args.status ?? 'cancelled',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    updatedAt: args.updatedAt,
  });
  return id;
}

/**
 * Covers the recent-partners endpoint that powers HandlePickerDialog's
 * "Recent" chips row. Gates: distinct counterpart dedupe, newest-first
 * ordering, cap at 5, empty-array for new users.
 *
 * Reads from `trade_sessions` (the proposal flow was retired in Phase
 * C — sessions are now the only trade primitive).
 */
describeWithDb('GET /api/me/recent-partners', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdIds) {
      await db.delete(tradeSessions).where(eq(tradeSessions.id, id)).catch(() => {});
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
    // Two sessions with alice prove dedupe — the more-recent timestamp
    // wins and alice surfaces only once.
    createdIds.push(await insertSession({
      viewerId: viewer.id,
      counterpartId: carol.id,
      updatedAt: new Date(now - 4000),
    }));
    createdIds.push(await insertSession({
      viewerId: viewer.id,
      counterpartId: alice.id,
      updatedAt: new Date(now - 3000),
    }));
    createdIds.push(await insertSession({
      viewerId: viewer.id,
      counterpartId: bob.id,
      updatedAt: new Date(now - 2000),
    }));
    createdIds.push(await insertSession({
      viewerId: viewer.id,
      counterpartId: alice.id,
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
      createdIds.push(await insertSession({
        viewerId: viewer.id,
        counterpartId: others[i].id,
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

  it('returns an empty array when the viewer has no sessions', async () => {
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

  it('skips open-slot sessions where userBId is still null', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);

    // Open-slot session: viewer in userAId, userBId NULL. No counterpart
    // yet → should not surface in recent partners.
    const id = crypto.randomUUID();
    const db = getDb();
    await db.insert(tradeSessions).values({
      id,
      userAId: viewer.id,
      userBId: null,
      userACards: [snapshot('p-1')],
      userBCards: [],
      status: 'active',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });
    createdIds.push(id);

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleRecentPartners(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { partners: unknown[] };
    expect(body.partners).toEqual([]);
  });
});
