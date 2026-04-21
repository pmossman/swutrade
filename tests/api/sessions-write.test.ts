import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleCancelSession,
  handleConfirmSession,
  handleCreateSession,
  handleEditSession,
} from '../../api/sessions.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeSessions, type TradeCardSnapshot } from '../../lib/schema.js';
import { createOpenSession, getSessionForViewer } from '../../lib/sessions.js';

function snap(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1 };
}

/**
 * Covers the write-side of `/api/sessions/*`:
 *   - create: pair uniqueness redirect, self-trade guard, unknown
 *     handle 404, initial cards seeded to creator's side only
 *   - edit: per-side ownership (can't edit counterpart's cards),
 *     confirmations cleared, lastEditedBy updated
 *   - confirm: idempotent, both-confirmed → settled
 *   - cancel: terminal transition, idempotent when already terminal
 */
describeWithDb('POST /api/sessions — write endpoints', () => {
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

  // Helper: create a session via the API; captures id for cleanup.
  async function createSession(viewer: { id: string; handle: string }, counterpartHandle: string, initialCards: TradeCardSnapshot[] = []) {
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { counterpartHandle, initialCards },
    });
    const res = mockResponse();
    await handleCreateSession(req, res);
    const body = res._json as { id?: string; created?: boolean; error?: string };
    if (body.id) createdIds.push(body.id);
    return { status: res._status, body };
  }

  it('creates a session, seeds cards on creator side, 201', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    const { status, body } = await createSession(alice, bob.handle, [snap('a-1', 2)]);
    expect(status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.id).toBeDefined();

    // Verify seeded state via DB lookup.
    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, body.id!));
    const aliceIsA = row.userAId === alice.id;
    const aliceCards = aliceIsA ? row.userACards : row.userBCards;
    const bobCards = aliceIsA ? row.userBCards : row.userACards;
    expect(aliceCards).toHaveLength(1);
    expect(aliceCards[0].productId).toBe('a-1');
    expect(bobCards).toHaveLength(0);
  });

  it('redirects into an existing active session with the same counterpart (200, created=false)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    const first = await createSession(alice, bob.handle);
    expect(first.status).toBe(201);
    const second = await createSession(alice, bob.handle);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.id).toBe(first.body.id);
  });

  it('400s when creator tries to start a trade with themselves', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const { status } = await createSession(alice, alice.handle);
    expect(status).toBe(400);
  });

  it('404s when the counterpart handle is unknown', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const { status } = await createSession(alice, 'nonexistenthandle999');
    expect(status).toBe(404);
  });

  it('edit replaces the viewer\'s half; counterpart half untouched; confirmations cleared', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const created = await createSession(alice, bob.handle, [snap('a-1')]);
    const id = created.body.id!;

    // Bob confirms first (optimistic early confirm).
    let res = mockResponse();
    await handleConfirmSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(bob.id) },
        query: { id },
      }),
      res,
    );
    expect(res._status).toBe(200);

    // Alice edits her side — should clear bob's confirmation.
    res = mockResponse();
    await handleEditSession(
      mockRequest({
        method: 'PUT',
        cookies: { swu_session: await sealTestCookie(alice.id) },
        query: { id },
        body: { cards: [snap('a-1'), snap('a-2', 3)] },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, id));
    expect(row.confirmedByUserIds).toEqual([]);
    expect(row.lastEditedByUserId).toBe(alice.id);
    const aliceIsA = row.userAId === alice.id;
    const aliceCards = aliceIsA ? row.userACards : row.userBCards;
    const bobCards = aliceIsA ? row.userBCards : row.userACards;
    expect(aliceCards.map(c => c.productId).sort()).toEqual(['a-1', 'a-2']);
    expect(bobCards).toHaveLength(0);
  });

  it('confirm + counterpart confirm → session settles', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const created = await createSession(alice, bob.handle);
    const id = created.body.id!;

    // Alice confirms (solo).
    let res = mockResponse();
    await handleConfirmSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(alice.id) },
        query: { id },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect((res._json as { settled: boolean }).settled).toBe(false);

    // Bob confirms — should settle.
    res = mockResponse();
    await handleConfirmSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(bob.id) },
        query: { id },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect((res._json as { settled: boolean }).settled).toBe(true);

    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, id));
    expect(row.status).toBe('settled');
    expect(row.settledAt).not.toBeNull();
  });

  it('confirm is idempotent — confirming twice does not re-settle', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const created = await createSession(alice, bob.handle);
    const id = created.body.id!;

    const cookie = await sealTestCookie(alice.id);
    let res = mockResponse();
    await handleConfirmSession(
      mockRequest({ method: 'POST', cookies: { swu_session: cookie }, query: { id } }),
      res,
    );
    expect(res._status).toBe(200);
    res = mockResponse();
    await handleConfirmSession(
      mockRequest({ method: 'POST', cookies: { swu_session: cookie }, query: { id } }),
      res,
    );
    expect(res._status).toBe(200);
    // Still not settled — bob hasn't confirmed.
    expect((res._json as { settled: boolean }).settled).toBe(false);
  });

  it('cancel transitions active session to cancelled; a new one can be created after', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const created = await createSession(alice, bob.handle);
    const id = created.body.id!;

    const res = mockResponse();
    await handleCancelSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(alice.id) },
        query: { id },
      }),
      res,
    );
    expect(res._status).toBe(200);

    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, id));
    expect(row.status).toBe('cancelled');

    // Now a new session between the same pair is allowed.
    const next = await createSession(alice, bob.handle);
    expect(next.status).toBe(201);
    expect(next.body.created).toBe(true);
    expect(next.body.id).not.toBe(id);
  });

  it('cancel on an open-slot session flips openSlot to false so the UI routes to the terminal banner', async () => {
    // Regression guard: `openSlot` used to be derived purely from
    // `userBId === null`, which left a just-cancelled open invitation
    // rendering the QR card (because `userBId` is still null after a
    // cancel). The fix derives openSlot as "unclaimed AND active" so
    // clients can use it as a "show the invite surface" gate without
    // also having to know about terminal states.
    const alice = await createTestUser();
    fixtures.push(alice);
    const db = getDb();

    const { id } = await createOpenSession(db, { creatorUserId: alice.id });
    createdIds.push(id);

    // Before cancel: open-slot live invite.
    const before = await getSessionForViewer(db, id, alice.id);
    expect(before?.openSlot).toBe(true);
    expect(before?.status).toBe('active');

    const res = mockResponse();
    await handleCancelSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(alice.id) },
        query: { id },
      }),
      res,
    );
    expect(res._status).toBe(200);

    const body = res._json as { session: { openSlot: boolean; status: string } };
    expect(body.session.status).toBe('cancelled');
    expect(body.session.openSlot).toBe(false);

    // And a fresh read (cache-bypassing) agrees.
    const after = await getSessionForViewer(db, id, alice.id);
    expect(after?.openSlot).toBe(false);
    expect(after?.status).toBe('cancelled');
  });

  it('edit returns 404 for a non-participant viewer (no leakage)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const outsider = await createTestUser();
    fixtures.push(outsider);
    const created = await createSession(alice, bob.handle);
    const id = created.body.id!;

    const res = mockResponse();
    await handleEditSession(
      mockRequest({
        method: 'PUT',
        cookies: { swu_session: await sealTestCookie(outsider.id) },
        query: { id },
        body: { cards: [snap('evil')] },
      }),
      res,
    );
    expect(res._status).toBe(404);
  });
});
