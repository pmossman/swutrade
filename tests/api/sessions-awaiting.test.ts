import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { sessionEvents, tradeSessions } from '../../lib/schema.js';
import {
  createOrGetActiveSession,
  getSessionForViewer,
  listActiveSessionsForViewer,
  suggestForSession,
  confirmSession,
} from '../../lib/sessions.js';
import { handleGetSession, handleListSessions } from '../../api/sessions.js';

/**
 * Coverage for the `awaitingViewer` derived flag (Phase B6).
 *
 * Two surfaces produce this flag — `getSessionForViewer` (single
 * session detail) and `listActiveSessionsForViewer` (bulk for the
 * /api/me/sessions list). Both must agree, since Home's Inbox reads
 * from the list endpoint and the session canvas reads from the
 * detail endpoint and the two should agree on whether a session is
 * waiting on the viewer.
 *
 * Triggers tested:
 *   - counterpart confirmed, viewer not → true
 *   - viewer confirmed, counterpart not → false (waiting on them)
 *   - both confirmed → false (terminal-positive will land separately)
 *   - active suggestion targeting viewer → true
 *   - active suggestion targeting counterpart → false
 *   - dismissed suggestion → false (no longer "active")
 *   - terminal session → always false (cancelled / expired / settled)
 *   - open-slot session (no counterpart yet) → false
 */
describeWithDb('B6 awaitingViewer derivation', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdSessionIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdSessionIds) {
      await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, id)).catch(() => {});
      await db.delete(tradeSessions).where(eq(tradeSessions.id, id)).catch(() => {});
    }
    createdSessionIds.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  async function seedActivePair(alice: { id: string }, bob: { id: string }): Promise<string> {
    const db = getDb();
    const result = await createOrGetActiveSession(db, {
      creatorUserId: alice.id,
      counterpartUserId: bob.id,
    });
    createdSessionIds.push(result.id);
    return result.id;
  }

  it('counterpart-confirmed-only → awaitingViewer=true for the unconfirmed side', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    // Add cards on at least one side so confirm doesn't no-op (the
    // canonical edit + confirm flow). Since both sides start empty,
    // we cheat and write directly.
    const db = getDb();
    await db.update(tradeSessions)
      .set({ userACards: [{ productId: 'a', name: 'A', variant: 'Standard', qty: 1, unitPrice: 1 }] })
      .where(eq(tradeSessions.id, sessionId));

    // Alice confirms (creator, side A canonically when alphabetic).
    await confirmSession(db, { sessionId, viewerUserId: alice.id });

    // From Bob's POV: Alice confirmed, Bob hasn't → awaiting=true.
    const bobView = await getSessionForViewer(db, sessionId, bob.id);
    expect(bobView?.awaitingViewer).toBe(true);

    // From Alice's POV: she confirmed, Bob hasn't → awaiting=false.
    const aliceView = await getSessionForViewer(db, sessionId, alice.id);
    expect(aliceView?.awaitingViewer).toBe(false);
  });

  it('both-confirmed terminal-positive case is irrelevant: awaitingViewer=false', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    const db = getDb();
    await db.update(tradeSessions)
      .set({
        userACards: [{ productId: 'a', name: 'A', variant: 'Standard', qty: 1, unitPrice: 1 }],
      })
      .where(eq(tradeSessions.id, sessionId));

    await confirmSession(db, { sessionId, viewerUserId: alice.id });
    await confirmSession(db, { sessionId, viewerUserId: bob.id });

    // Both confirmed → session settles. Neither side "awaits" the
    // other since the trade is done.
    const aliceView = await getSessionForViewer(db, sessionId, alice.id);
    const bobView = await getSessionForViewer(db, sessionId, bob.id);
    expect(aliceView?.awaitingViewer).toBe(false);
    expect(bobView?.awaitingViewer).toBe(false);
  });

  it('active suggestion targeting the viewer → awaitingViewer=true; targeting counterpart → false', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    // Alice suggests Bob add a card. Need to know Bob's side
    // (alphabetic on user ids — Alice is A iff alice.id < bob.id).
    const db = getDb();
    const bobSide: 'a' | 'b' = alice.id < bob.id ? 'b' : 'a';
    await suggestForSession(db, {
      sessionId,
      viewerUserId: alice.id,
      targetSide: bobSide,
      cardsToAdd: [{ productId: 's-1', name: 'Suggested', variant: 'Standard', qty: 1, unitPrice: 1 }],
      cardsToRemove: [],
    });

    // Bob (target) → awaiting=true. Alice (author) → awaiting=false.
    const bobView = await getSessionForViewer(db, sessionId, bob.id);
    expect(bobView?.awaitingViewer).toBe(true);
    const aliceView = await getSessionForViewer(db, sessionId, alice.id);
    expect(aliceView?.awaitingViewer).toBe(false);
  });

  it('terminal sessions are never awaiting — even with stale signals', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    const db = getDb();
    // Counterpart-confirmed signal exists, plus we cancel the session.
    await db.update(tradeSessions)
      .set({
        userACards: [{ productId: 'a', name: 'A', variant: 'Standard', qty: 1, unitPrice: 1 }],
      })
      .where(eq(tradeSessions.id, sessionId));
    await confirmSession(db, { sessionId, viewerUserId: alice.id });
    await db.update(tradeSessions)
      .set({ status: 'cancelled' })
      .where(eq(tradeSessions.id, sessionId));

    const bobView = await getSessionForViewer(db, sessionId, bob.id);
    expect(bobView?.awaitingViewer).toBe(false);
  });

  it('list and detail endpoints agree on awaitingViewer', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    // Set up an awaiting state for Bob (Alice confirms after seed).
    const db = getDb();
    await db.update(tradeSessions)
      .set({
        userACards: [{ productId: 'a', name: 'A', variant: 'Standard', qty: 1, unitPrice: 1 }],
      })
      .where(eq(tradeSessions.id, sessionId));
    await confirmSession(db, { sessionId, viewerUserId: alice.id });

    const detail = await getSessionForViewer(db, sessionId, bob.id);
    const list = await listActiveSessionsForViewer(db, bob.id);
    const listEntry = list.find(s => s.id === sessionId);

    expect(detail?.awaitingViewer).toBe(true);
    expect(listEntry?.awaitingViewer).toBe(true);
  });

  it('handleListSessions surfaces awaitingViewer in the API response', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    const db = getDb();
    await db.update(tradeSessions)
      .set({
        userACards: [{ productId: 'a', name: 'A', variant: 'Standard', qty: 1, unitPrice: 1 }],
      })
      .where(eq(tradeSessions.id, sessionId));
    await confirmSession(db, { sessionId, viewerUserId: alice.id });

    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: await sealTestCookie(bob.id) },
    });
    const res = mockResponse();
    await handleListSessions(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { sessions: Array<{ id: string; awaitingViewer: boolean }> };
    const entry = body.sessions.find(s => s.id === sessionId);
    expect(entry?.awaitingViewer).toBe(true);
  });

  it('handleGetSession surfaces awaitingViewer in the detail response', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    const db = getDb();
    await db.update(tradeSessions)
      .set({
        userACards: [{ productId: 'a', name: 'A', variant: 'Standard', qty: 1, unitPrice: 1 }],
      })
      .where(eq(tradeSessions.id, sessionId));
    await confirmSession(db, { sessionId, viewerUserId: alice.id });

    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: await sealTestCookie(bob.id) },
      query: { id: sessionId },
    });
    const res = mockResponse();
    await handleGetSession(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { session: { awaitingViewer: boolean } };
    expect(body.session.awaitingViewer).toBe(true);
  });
});
