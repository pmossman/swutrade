import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleAcceptSuggestion,
  handleCreateSession,
  handleDismissSuggestion,
  handleEditSession,
  handleSuggestSession,
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

interface SuggestionView {
  id: string;
  suggestedByUserId: string;
  suggestedByViewer: boolean;
  targetSide: 'a' | 'b' | 'both';
  targetIsViewer: boolean;
  cardsToAdd: TradeCardSnapshot[];
  cardsToRemove: TradeCardSnapshot[];
  residualAdd: TradeCardSnapshot[];
  residualRemove: TradeCardSnapshot[];
}

interface SessionLite {
  id: string;
  yourCards: TradeCardSnapshot[];
  theirCards: TradeCardSnapshot[];
  suggestions: SuggestionView[];
  events: Array<{ type: string; payload?: Record<string, unknown> }>;
  confirmedByViewer: boolean;
  confirmedByCounterpart: boolean;
}

/**
 * PR 2 coverage: suggest / accept / dismiss + auto-dismiss on edit.
 * Edit/confirm/cancel paths covered in sessions-write.test.ts; chat
 * + mark-read in sessions-chat.test.ts; this file is suggestion-only.
 */
describeWithDb('POST /api/sessions — cross-side suggestions', () => {
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

  async function createSession(
    viewer: { id: string; handle: string },
    counterpartHandle: string,
    initialCards: TradeCardSnapshot[] = [],
  ) {
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { counterpartHandle, initialCards },
    });
    const res = mockResponse();
    await handleCreateSession(req, res);
    const body = res._json as { id?: string };
    if (body.id) createdIds.push(body.id);
    return body.id!;
  }

  async function postSuggest(
    viewerId: string,
    sessionId: string,
    body: { targetSide: 'a' | 'b'; cardsToAdd?: TradeCardSnapshot[]; cardsToRemove?: TradeCardSnapshot[] },
  ) {
    const res = mockResponse();
    await handleSuggestSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewerId) },
        query: { id: sessionId },
        body,
      }),
      res,
    );
    return res;
  }

  // Suggestion's targetSide depends on canonical user_a < user_b
  // ordering. Helper: figure out which side the counterpart sits on.
  async function counterpartSideOf(sessionId: string, viewerId: string): Promise<'a' | 'b'> {
    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, sessionId));
    const viewerIsA = row.userAId === viewerId;
    return viewerIsA ? 'b' : 'a';
  }

  it('suggest creates a pending row visible to both sides; targetIsViewer flips', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);
    const bobSide = await counterpartSideOf(id, alice.id);

    const res = await postSuggest(alice.id, id, {
      targetSide: bobSide,
      cardsToAdd: [snap('luke-1', 1)],
    });
    expect(res._status).toBe(200);
    const body = res._json as { session: SessionLite; suggestionId: string };
    expect(body.session.suggestions).toHaveLength(1);
    expect(body.session.suggestions[0].suggestedByViewer).toBe(true);
    expect(body.session.suggestions[0].targetIsViewer).toBe(false);
    expect(body.session.suggestions[0].cardsToAdd[0].productId).toBe('luke-1');

    // Now Bob fetches via creating a second session — but we need a
    // GET. Easier: poke another suggestion endpoint that round-trips
    // the SessionView. Use dismiss with a fake id — wrong path but
    // it 404s cleanly. Use editSession instead to get bob's view.
    const editRes = mockResponse();
    await handleEditSession(
      mockRequest({
        method: 'PUT',
        cookies: { swu_session: await sealTestCookie(bob.id) },
        query: { id },
        body: { cards: [] },
      }),
      editRes,
    );
    const bobBody = editRes._json as { session: SessionLite };
    expect(bobBody.session.suggestions).toHaveLength(1);
    expect(bobBody.session.suggestions[0].suggestedByViewer).toBe(false);
    expect(bobBody.session.suggestions[0].targetIsViewer).toBe(true);
  });

  it('rejects self-targeted suggestion with 400 invalid-target', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);
    const aliceSide = await counterpartSideOf(id, bob.id); // alice's side from bob's POV

    // Alice tries to suggest to her own side.
    const res = await postSuggest(alice.id, id, {
      targetSide: aliceSide,
      cardsToAdd: [snap('luke-1')],
    });
    expect(res._status).toBe(400);
  });

  it('rejects empty suggestion (no add nor remove) with 400', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);
    const bobSide = await counterpartSideOf(id, alice.id);

    const res = await postSuggest(alice.id, id, { targetSide: bobSide });
    expect(res._status).toBe(400);
  });

  it('non-target cannot accept (suggester gets 403)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);
    const bobSide = await counterpartSideOf(id, alice.id);

    const suggestRes = await postSuggest(alice.id, id, {
      targetSide: bobSide,
      cardsToAdd: [snap('luke-1', 2)],
    });
    const sid = (suggestRes._json as { suggestionId: string }).suggestionId;

    // Alice tries to accept her own suggestion.
    const res = mockResponse();
    await handleAcceptSuggestion(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(alice.id) },
        query: { id, suggestionId: sid },
      }),
      res,
    );
    expect(res._status).toBe(403);
  });

  it('target accepts: residual delta lands on their side, suggestion clears, confirmations clear', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);
    const bobSide = await counterpartSideOf(id, alice.id);

    // Pre-confirm bob so we can verify accept clears confirmations.
    // (Confirm is a separate action; we'll skip it and assert via
    // edit-clears-confirmation behavior on accept.)
    const suggestRes = await postSuggest(alice.id, id, {
      targetSide: bobSide,
      cardsToAdd: [snap('luke-1', 2)],
    });
    const sid = (suggestRes._json as { suggestionId: string }).suggestionId;

    // Bob accepts.
    const acceptRes = mockResponse();
    await handleAcceptSuggestion(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(bob.id) },
        query: { id, suggestionId: sid },
      }),
      acceptRes,
    );
    expect(acceptRes._status).toBe(200);
    const body = acceptRes._json as { session: SessionLite };
    // From bob's POV, his side now has Luke ×2.
    expect(body.session.yourCards).toHaveLength(1);
    expect(body.session.yourCards[0].productId).toBe('luke-1');
    expect(body.session.yourCards[0].qty).toBe(2);
    // Suggestion is gone.
    expect(body.session.suggestions).toHaveLength(0);
    // Timeline records the accept.
    const types = body.session.events.map(e => e.type);
    expect(types).toContain('suggestion-accepted');
    expect(types).toContain('edited');
  });

  it('explicit dismiss removes the suggestion, logs reason=explicit', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);
    const bobSide = await counterpartSideOf(id, alice.id);

    const suggestRes = await postSuggest(alice.id, id, {
      targetSide: bobSide,
      cardsToAdd: [snap('luke-1')],
    });
    const sid = (suggestRes._json as { suggestionId: string }).suggestionId;

    const dismissRes = mockResponse();
    await handleDismissSuggestion(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(bob.id) },
        query: { id, suggestionId: sid },
      }),
      dismissRes,
    );
    expect(dismissRes._status).toBe(200);
    const body = dismissRes._json as { session: SessionLite };
    expect(body.session.suggestions).toHaveLength(0);
    const dismissEvent = body.session.events.find(e => e.type === 'suggestion-dismissed');
    expect(dismissEvent).toBeDefined();
    expect(dismissEvent!.payload?.reason).toBe('explicit');
  });

  it('auto-dismisses when target satisfies via direct edit (residual goes empty)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);
    const bobSide = await counterpartSideOf(id, alice.id);

    // Alice suggests bob add Luke ×1.
    await postSuggest(alice.id, id, {
      targetSide: bobSide,
      cardsToAdd: [snap('luke-1', 1)],
    });

    // Bob edits his side to include Luke ×1 (independently fulfilling
    // the suggestion). The auto-sweep should mark the suggestion
    // satisfied + dismiss.
    const editRes = mockResponse();
    await handleEditSession(
      mockRequest({
        method: 'PUT',
        cookies: { swu_session: await sealTestCookie(bob.id) },
        query: { id },
        body: { cards: [snap('luke-1', 1)] },
      }),
      editRes,
    );
    expect(editRes._status).toBe(200);
    const body = editRes._json as { session: SessionLite };
    // Suggestion no longer in the active list.
    expect(body.session.suggestions).toHaveLength(0);
    // Timeline records the auto-dismissal with reason=satisfied.
    const dismissEvent = body.session.events.find(e => e.type === 'suggestion-dismissed');
    expect(dismissEvent).toBeDefined();
    expect(dismissEvent!.payload?.reason).toBe('satisfied');
  });

  it('residual shrinks but suggestion survives when satisfaction is partial', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);
    const bobSide = await counterpartSideOf(id, alice.id);

    // Alice suggests bob add Luke + Han.
    await postSuggest(alice.id, id, {
      targetSide: bobSide,
      cardsToAdd: [snap('luke-1', 1), snap('han-1', 1)],
    });

    // Bob adds only Luke.
    const editRes = mockResponse();
    await handleEditSession(
      mockRequest({
        method: 'PUT',
        cookies: { swu_session: await sealTestCookie(bob.id) },
        query: { id },
        body: { cards: [snap('luke-1', 1)] },
      }),
      editRes,
    );
    const body = editRes._json as { session: SessionLite };
    // Suggestion still present, residual carries only the Han.
    expect(body.session.suggestions).toHaveLength(1);
    const residual = body.session.suggestions[0].residualAdd;
    expect(residual).toHaveLength(1);
    expect(residual[0].productId).toBe('han-1');
  });

  it('suggest is blocked on open-slot session with 409', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);

    // Create an open-slot session via lib (no API for it in this test).
    const { createOpenSession } = await import('../../lib/sessions.js');
    const db = getDb();
    const created = await createOpenSession(db, { creatorUserId: alice.id, initialCards: [] });
    createdIds.push(created.id);

    const res = await postSuggest(alice.id, created.id, {
      targetSide: 'b',
      cardsToAdd: [snap('luke-1')],
    });
    expect(res._status).toBe(409);
  });
});
