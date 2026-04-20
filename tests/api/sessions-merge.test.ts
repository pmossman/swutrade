import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mockResponse,
  mockRequest,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeSessions, users, type TradeCardSnapshot } from '../../lib/schema.js';
import {
  createGhostUser,
  createOpenSession,
  createOrGetActiveSession,
  mergeGhostIntoRealUser,
  nextExpiresAt,
  normalizeParticipants,
} from '../../lib/sessions.js';
import { getSession } from '../../lib/auth.js';

function snap(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1 };
}

/**
 * Covers the ghost → real user migration fired from the OAuth
 * callback. The user opens /s/<id>, claims anonymously (ghost row +
 * cookie), does some editing, then signs in with Discord. Their
 * ghost's sessions should follow them into the real account.
 */
describeWithDb('mergeGhostIntoRealUser', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdSessionIds: string[] = [];
  const createdUserIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdSessionIds) {
      await db.delete(tradeSessions).where(eq(tradeSessions.id, id)).catch(() => {});
    }
    createdSessionIds.length = 0;
    for (const id of createdUserIds) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
    createdUserIds.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('migrates a ghost-claimed session to the real user and deletes the ghost row', async () => {
    const db = getDb();
    const alice = await createTestUser();
    fixtures.push(alice);
    const realBob = await createTestUser();
    fixtures.push(realBob);

    // Alice creates an open session; ghost claims slot B.
    const open = await createOpenSession(db, {
      creatorUserId: alice.id,
      creatorCards: [snap('a-1', 2)],
    });
    createdSessionIds.push(open.id);

    const ghost = await createGhostUser(db);
    createdUserIds.push(ghost.id);
    const { userAId, userBId } = normalizeParticipants(alice.id, ghost.id);
    const aliceInA = userAId === alice.id;
    await db
      .update(tradeSessions)
      .set({
        userAId,
        userBId,
        userACards: aliceInA ? [snap('a-1', 2)] : [snap('g-1')],
        userBCards: aliceInA ? [snap('g-1')] : [snap('a-1', 2)],
        confirmedByUserIds: [ghost.id],
        lastEditedByUserId: ghost.id,
      })
      .where(eq(tradeSessions.id, open.id));

    // Ghost signs in as realBob — merge time.
    await mergeGhostIntoRealUser(db, ghost.id, realBob.id);

    const [after] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, open.id));
    expect(after).toBeDefined();
    // Participants should be (alice, realBob) in canonical order.
    const participants = [after.userAId, after.userBId].sort();
    expect(participants).toEqual([alice.id, realBob.id].sort());
    // Ghost's confirmation carried to realBob.
    expect(after.confirmedByUserIds).toContain(realBob.id);
    expect(after.confirmedByUserIds).not.toContain(ghost.id);
    // lastEditedByUserId promoted.
    expect(after.lastEditedByUserId).toBe(realBob.id);
    // Ghost's cards follow the ghost identity — should now be
    // attached to realBob.
    const realInA = after.userAId === realBob.id;
    const realCards = realInA ? after.userACards : after.userBCards;
    expect(realCards.map(c => c.productId)).toEqual(['g-1']);

    // Ghost user row was deleted.
    const ghostStill = await db.select().from(users).where(eq(users.id, ghost.id));
    expect(ghostStill).toHaveLength(0);
    // Remove from cleanup list since it's gone.
    createdUserIds.splice(createdUserIds.indexOf(ghost.id), 1);
  });

  it('handles an open (slot-B-null) session the ghost created — just rewrites slot A', async () => {
    const db = getDb();
    const realUser = await createTestUser();
    fixtures.push(realUser);

    const ghost = await createGhostUser(db);
    createdUserIds.push(ghost.id);
    const open = await createOpenSession(db, {
      creatorUserId: ghost.id,
      creatorCards: [snap('g-own')],
    });
    createdSessionIds.push(open.id);

    await mergeGhostIntoRealUser(db, ghost.id, realUser.id);

    const [after] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, open.id));
    expect(after.userAId).toBe(realUser.id);
    expect(after.userBId).toBeNull();
    // Ghost row deleted cleanly.
    const ghostStill = await db.select().from(users).where(eq(users.id, ghost.id));
    expect(ghostStill).toHaveLength(0);
    createdUserIds.splice(createdUserIds.indexOf(ghost.id), 1);
  });

  it("leaves the ghost row alive when a pair-uniqueness conflict blocks migration", async () => {
    const db = getDb();
    const alice = await createTestUser();
    fixtures.push(alice);
    const realBob = await createTestUser();
    fixtures.push(realBob);

    // realBob already has an active session with alice (blocker for merge).
    const realPair = await createOrGetActiveSession(db, {
      creatorUserId: realBob.id,
      counterpartUserId: alice.id,
    });
    createdSessionIds.push(realPair.id);

    // Ghost-Alice session: ghost is slot B.
    const ghost = await createGhostUser(db);
    createdUserIds.push(ghost.id);
    const ghostSessionId = (await createOpenSession(db, { creatorUserId: alice.id })).id;
    createdSessionIds.push(ghostSessionId);
    const { userAId, userBId } = normalizeParticipants(alice.id, ghost.id);
    await db
      .update(tradeSessions)
      .set({ userAId, userBId, expiresAt: nextExpiresAt() })
      .where(eq(tradeSessions.id, ghostSessionId));

    await mergeGhostIntoRealUser(db, ghost.id, realBob.id);

    // Ghost session still references the ghost (couldn't migrate).
    const [after] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, ghostSessionId));
    const participants = [after.userAId, after.userBId];
    expect(participants).toContain(ghost.id);
    // Ghost row stays alive because a session still references it.
    const ghostStill = await db.select().from(users).where(eq(users.id, ghost.id));
    expect(ghostStill).toHaveLength(1);
  });
});

describeWithDb('getSession returns isAnonymous for ghost cookies', () => {
  it('propagates the flag so client code can gate UI', async () => {
    const db = getDb();
    const ghost = await createGhostUser(db);
    try {
      const cookie = await sealTestCookie(ghost.id, { isAnonymous: true });
      const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
      const res = mockResponse();
      const session = await getSession(req, res);
      expect(session?.isAnonymous).toBe(true);
    } finally {
      await db.delete(users).where(eq(users.id, ghost.id));
    }
  });
});
