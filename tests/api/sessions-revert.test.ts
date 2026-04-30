import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleAcceptSuggestion,
  handleCreateSession,
  handleEditSession,
  handleProposeRevertSession,
} from '../../api/sessions.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeSessions, type TradeCardSnapshot } from '../../lib/schema.js';

function snap(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1 };
}

interface SessionLite {
  yourCards: TradeCardSnapshot[];
  theirCards: TradeCardSnapshot[];
  suggestions: Array<{
    id: string;
    targetSide: 'a' | 'b' | 'both';
    suggestedByViewer: boolean;
    bothSidesSnapshot?: { yourCards: TradeCardSnapshot[]; theirCards: TradeCardSnapshot[] };
  }>;
  events: Array<{ id: string; type: string; payload?: Record<string, unknown> }>;
}

/**
 * PR 3 coverage: propose-revert + accept on 'both'-target suggestions
 * + auto-dismiss when current state matches the snapshot.
 */
describeWithDb('POST /api/sessions — revert (snapshot history)', () => {
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

  async function createSession(viewer: { id: string; handle: string }, counterpartHandle: string) {
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { counterpartHandle, initialCards: [] },
    });
    const res = mockResponse();
    await handleCreateSession(req, res);
    const id = (res._json as { id?: string }).id!;
    createdIds.push(id);
    return id;
  }

  async function edit(viewerId: string, sessionId: string, cards: TradeCardSnapshot[]) {
    const res = mockResponse();
    await handleEditSession(
      mockRequest({
        method: 'PUT',
        cookies: { swu_session: await sealTestCookie(viewerId) },
        query: { id: sessionId },
        body: { cards },
      }),
      res,
    );
    return res._json as { session: SessionLite };
  }

  async function proposeRevert(viewerId: string, sessionId: string, snapshotEventId: string) {
    const res = mockResponse();
    await handleProposeRevertSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewerId) },
        query: { id: sessionId },
        body: { snapshotEventId },
      }),
      res,
    );
    return res;
  }

  it('proposes a revert; counterpart accepts; both sides flip to the snapshot state', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);

    // Alice edits → snapshot 1.
    const e1 = await edit(alice.id, id, [snap('luke-1', 1)]);
    const snap1 = e1.session.events.find(ev => ev.type === 'edit-snapshot')!;

    // Bob edits → snapshot 2.
    const e2 = await edit(bob.id, id, [snap('han-1', 1)]);
    expect(e2.session.events.find(ev => ev.type === 'edited')).toBeDefined();

    // Alice proposes revert to snapshot 1.
    const proposeRes = await proposeRevert(alice.id, id, snap1.id);
    expect(proposeRes._status).toBe(200);
    const sid = (proposeRes._json as { suggestionId: string }).suggestionId;

    // Alice can't accept her own revert.
    const aliceAcceptRes = mockResponse();
    await handleAcceptSuggestion(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(alice.id) },
        query: { id, suggestionId: sid },
      }),
      aliceAcceptRes,
    );
    expect(aliceAcceptRes._status).toBe(403);

    // Bob accepts — both sides revert atomically.
    const bobAcceptRes = mockResponse();
    await handleAcceptSuggestion(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(bob.id) },
        query: { id, suggestionId: sid },
      }),
      bobAcceptRes,
    );
    expect(bobAcceptRes._status).toBe(200);

    // After accept, fetch via another edit (no-change cards re-state).
    // Use direct DB read for clarity.
    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, id));
    const aliceIsA = row.userAId === alice.id;
    const aliceCards = aliceIsA ? row.userACards : row.userBCards;
    const bobCards = aliceIsA ? row.userBCards : row.userACards;
    // At snapshot 1: alice had luke-1, bob had nothing.
    expect(aliceCards.map(c => c.productId)).toEqual(['luke-1']);
    expect(bobCards).toEqual([]);
    // Confirmations were cleared.
    expect(row.confirmedByUserIds).toEqual([]);
  });

  it('refuses a revert to the current state (no-op) with 400', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);

    // Alice edits.
    const e1 = await edit(alice.id, id, [snap('luke-1', 1)]);
    const snap1 = e1.session.events.find(ev => ev.type === 'edit-snapshot')!;

    // Propose revert immediately — current state == snapshot.
    const res = await proposeRevert(alice.id, id, snap1.id);
    expect(res._status).toBe(400);
  });

  it('auto-dismisses a pending revert when the current state happens to match the snapshot', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);

    // Alice edits twice.
    const e1 = await edit(alice.id, id, [snap('luke-1', 1)]);
    const snap1 = e1.session.events.find(ev => ev.type === 'edit-snapshot')!;
    await edit(alice.id, id, [snap('luke-1', 1), snap('han-1', 1)]);

    // Alice proposes revert to snap1.
    const proposeRes = await proposeRevert(alice.id, id, snap1.id);
    expect(proposeRes._status).toBe(200);

    // Alice manually edits back to snap1 state (single luke). Auto-
    // sweep on edit should find the revert satisfied → auto-dismiss.
    const e3 = await edit(alice.id, id, [snap('luke-1', 1)]);
    expect(e3.session.suggestions).toHaveLength(0);
    const dismissEvent = e3.session.events.find(ev => ev.type === 'suggestion-dismissed');
    expect(dismissEvent).toBeDefined();
    expect(dismissEvent!.payload?.reason).toBe('satisfied');
  });

  it('rejects revert to a non-snapshot event id with 404 (no-such-snapshot)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);

    // Edit so we have at least an 'edited' event (non-snapshot).
    const e = await edit(alice.id, id, [snap('luke-1', 1)]);
    const editedEvent = e.session.events.find(ev => ev.type === 'edited')!;

    const res = await proposeRevert(alice.id, id, editedEvent.id);
    expect(res._status).toBe(404);
  });
});
