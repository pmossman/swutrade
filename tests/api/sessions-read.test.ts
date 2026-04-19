import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleGetSession, handleListSessions } from '../../api/sessions.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeSessions, type TradeCardSnapshot } from '../../lib/schema.js';
import {
  generateSessionCode,
  nextExpiresAt,
  normalizeParticipants,
} from '../../lib/sessions.js';

function snap(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1 };
}

async function insertSession(args: {
  viewer: string;
  counterpart: string;
  viewerCards?: TradeCardSnapshot[];
  counterpartCards?: TradeCardSnapshot[];
  status?: 'active' | 'settled' | 'cancelled' | 'expired';
  confirmedBy?: string[];
  lastEditedBy?: string | null;
  lastEditedAt?: Date;
}): Promise<string> {
  const id = generateSessionCode();
  const db = getDb();
  const { userAId, userBId } = normalizeParticipants(args.viewer, args.counterpart);
  const viewerIsA = userAId === args.viewer;
  await db.insert(tradeSessions).values({
    id,
    userAId,
    userBId,
    userACards: viewerIsA ? (args.viewerCards ?? []) : (args.counterpartCards ?? []),
    userBCards: viewerIsA ? (args.counterpartCards ?? []) : (args.viewerCards ?? []),
    status: args.status ?? 'active',
    confirmedByUserIds: args.confirmedBy ?? [],
    lastEditedByUserId: args.lastEditedBy ?? null,
    ...(args.lastEditedAt ? { lastEditedAt: args.lastEditedAt } : {}),
    expiresAt: nextExpiresAt(),
  });
  return id;
}

/**
 * Covers the read-side of `/api/sessions/*`. Gate: session ids are
 * 404'd for non-participants (not probeable), and the list endpoint
 * only returns active sessions the viewer participates in.
 */
describeWithDb('GET /api/sessions — read endpoints', () => {
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

  it('returns a session rehydrated viewer-centric for a participant', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const other = await createTestUser();
    fixtures.push(other);

    createdIds.push(await insertSession({
      viewer: viewer.id,
      counterpart: other.id,
      viewerCards: [snap('my-1', 2)],
      counterpartCards: [snap('their-1', 3)],
      confirmedBy: [viewer.id],
      lastEditedBy: other.id,
    }));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { id: createdIds[createdIds.length - 1] },
    });
    const res = mockResponse();
    await handleGetSession(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      session: {
        id: string;
        yourCards: TradeCardSnapshot[];
        theirCards: TradeCardSnapshot[];
        confirmedByViewer: boolean;
        confirmedByCounterpart: boolean;
        lastEditedByViewer: boolean;
        counterpart: { handle: string } | null;
      };
    };
    expect(body.session.yourCards[0].productId).toBe('my-1');
    expect(body.session.yourCards[0].qty).toBe(2);
    expect(body.session.theirCards[0].productId).toBe('their-1');
    expect(body.session.confirmedByViewer).toBe(true);
    expect(body.session.confirmedByCounterpart).toBe(false);
    expect(body.session.lastEditedByViewer).toBe(false);
    expect(body.session.counterpart?.handle).toBe(other.handle);
  });

  it('404s for a non-participant viewer (session ids not probeable)', async () => {
    const userA = await createTestUser();
    fixtures.push(userA);
    const userB = await createTestUser();
    fixtures.push(userB);
    const outsider = await createTestUser();
    fixtures.push(outsider);

    createdIds.push(await insertSession({
      viewer: userA.id,
      counterpart: userB.id,
    }));

    const cookie = await sealTestCookie(outsider.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { id: createdIds[createdIds.length - 1] },
    });
    const res = mockResponse();
    await handleGetSession(req, res);

    expect(res._status).toBe(404);
  });

  it('lists only active sessions, most-recently-edited first', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const carol = await createTestUser();
    fixtures.push(carol);

    const now = Date.now();
    createdIds.push(await insertSession({
      viewer: viewer.id,
      counterpart: alice.id,
      lastEditedAt: new Date(now - 3000),
    }));
    createdIds.push(await insertSession({
      viewer: viewer.id,
      counterpart: bob.id,
      lastEditedAt: new Date(now - 1000),
    }));
    // Cancelled session with carol shouldn't appear in the list.
    createdIds.push(await insertSession({
      viewer: viewer.id,
      counterpart: carol.id,
      status: 'cancelled',
      lastEditedAt: new Date(now - 500),
    }));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleListSessions(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      sessions: Array<{ counterpart: { userId: string } | null }>;
    };
    expect(body.sessions).toHaveLength(2);
    // Bob is most recent, Alice older.
    expect(body.sessions[0].counterpart?.userId).toBe(bob.id);
    expect(body.sessions[1].counterpart?.userId).toBe(alice.id);
  });

  it('400s when id is missing on GET', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: {},
    });
    const res = mockResponse();
    await handleGetSession(req, res);
    expect(res._status).toBe(400);
  });
});
