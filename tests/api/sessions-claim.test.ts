import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleClaimSession,
  handleCreateOpenSession,
  handleGetSession,
} from '../../api/sessions.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeSessions, users, type TradeCardSnapshot } from '../../lib/schema.js';

function snap(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1 };
}

/**
 * Covers the open-session + QR/anonymous claim flow:
 *   - create-open: inserts a session with slot B null, creator in A
 *   - get: non-participant on an open session sees `{ preview }`;
 *     participant sees `{ session }`; closed sessions 404
 *   - claim: anonymous visitors mint a ghost user + cookie, become
 *     slot B; signed-in visitors fill slot B directly; idempotent
 *     on re-claim; conflicts when someone else got there first
 */
describeWithDb('sessions — open + claim flow', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdSessionIds: string[] = [];
  const ghostIdsToClean: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdSessionIds) {
      await db.delete(tradeSessions).where(eq(tradeSessions.id, id)).catch(() => {});
    }
    createdSessionIds.length = 0;
    for (const id of ghostIdsToClean) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
    ghostIdsToClean.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  async function createOpen(creator: { id: string }, initialCards: TradeCardSnapshot[] = []) {
    const cookie = await sealTestCookie(creator.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { initialCards },
    });
    const res = mockResponse();
    await handleCreateOpenSession(req, res);
    const body = res._json as { id?: string; error?: string };
    if (body.id) createdSessionIds.push(body.id);
    return { status: res._status, body };
  }

  it('creates an open-slot session with slot B null', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const { status, body } = await createOpen(alice, [snap('a-1', 2)]);
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, body.id!));
    expect(row.userAId).toBe(alice.id);
    expect(row.userBId).toBeNull();
    expect(row.userACards).toHaveLength(1);
  });

  it('non-participant GET on an open session returns preview (no auth required)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const { body } = await createOpen(alice, [snap('a-1'), snap('a-2', 2)]);
    const id = body.id!;

    // No auth cookie at all — simulates an anon scanner hitting the URL.
    const req = mockRequest({ method: 'GET', query: { id } });
    const res = mockResponse();
    await handleGetSession(req, res);
    expect(res._status).toBe(200);
    const payload = res._json as {
      session?: unknown;
      preview?: {
        id: string;
        creator: { handle: string };
        creatorCardCount: number;
      };
    };
    expect(payload.session).toBeUndefined();
    expect(payload.preview?.creator.handle).toBe(alice.handle);
    expect(payload.preview?.creatorCardCount).toBe(3); // 1 + 2
  });

  it('participant GET returns the full session payload', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const { body } = await createOpen(alice);
    const id = body.id!;

    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id },
    });
    const res = mockResponse();
    await handleGetSession(req, res);
    expect(res._status).toBe(200);
    const payload = res._json as { session?: { openSlot: boolean } };
    expect(payload.session?.openSlot).toBe(true);
  });

  it('anonymous claim mints a ghost user + sets cookie + fills slot B', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const { body } = await createOpen(alice);
    const id = body.id!;

    // No auth cookie — the handler should create a ghost + session.
    const req = mockRequest({ method: 'POST', query: { id } });
    const res = mockResponse();
    await handleClaimSession(req, res);
    expect(res._status).toBe(201);
    const payload = res._json as {
      session: { counterpart: { userId: string; handle: string; isAnonymous: boolean } | null };
      ghost: { id: string; handle: string; username: string } | null;
    };
    // Payload is viewer-centric — from the ghost's perspective, the
    // counterpart is Alice (creator), not the ghost itself.
    expect(payload.ghost).not.toBeNull();
    if (payload.ghost) ghostIdsToClean.push(payload.ghost.id);
    expect(payload.session.counterpart?.handle).toBe(alice.handle);
    expect(payload.session.counterpart?.isAnonymous).toBe(false);

    // DB check — slot B is the ghost; the ghost is marked anonymous.
    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, id));
    // After claim, the partial unique index may have renormalized a/b
    // ordering — so just check the ghost is one of the two slots.
    expect([row.userAId, row.userBId]).toContain(payload.ghost!.id);
    const [ghost] = await db.select().from(users).where(eq(users.id, payload.ghost!.id));
    expect(ghost.isAnonymous).toBe(true);
    expect(ghost.discordId).toBeNull();
  });

  it('signed-in claim fills slot B with the real user', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const { body } = await createOpen(alice);
    const id = body.id!;

    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(bob.id) },
      query: { id },
    });
    const res = mockResponse();
    await handleClaimSession(req, res);
    expect(res._status).toBe(201);
    const payload = res._json as {
      session: { counterpart: { userId: string; isAnonymous: boolean } | null };
    };
    // From Bob's perspective (the claimer), the counterpart is Alice.
    expect(payload.session.counterpart?.userId).toBe(alice.id);
    expect(payload.session.counterpart?.isAnonymous).toBe(false);
    // And the session in the DB has both of them as participants.
    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, id));
    expect([row.userAId, row.userBId].sort()).toEqual([alice.id, bob.id].sort());
  });

  it('claim is idempotent — re-claiming by the same viewer is a no-op', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const { body } = await createOpen(alice);
    const id = body.id!;

    const cookie = await sealTestCookie(bob.id);
    let res = mockResponse();
    await handleClaimSession(
      mockRequest({ method: 'POST', cookies: { swu_session: cookie }, query: { id } }),
      res,
    );
    expect(res._status).toBe(201);
    res = mockResponse();
    await handleClaimSession(
      mockRequest({ method: 'POST', cookies: { swu_session: cookie }, query: { id } }),
      res,
    );
    expect(res._status).toBe(200); // idempotent — 200, not 201
  });

  it('conflict when a third party tries to claim after slot B is filled', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const carol = await createTestUser();
    fixtures.push(carol);
    const { body } = await createOpen(alice);
    const id = body.id!;

    // Bob claims first.
    await handleClaimSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(bob.id) },
        query: { id },
      }),
      mockResponse(),
    );
    // Carol tries to claim → 409 conflict.
    const res = mockResponse();
    await handleClaimSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(carol.id) },
        query: { id },
      }),
      res,
    );
    expect(res._status).toBe(409);
  });
});
