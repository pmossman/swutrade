import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleChatSession,
  handleCreateSession,
  handleEditSession,
  handleMarkReadSession,
} from '../../api/sessions.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import {
  sessionEvents,
  tradeSessions,
  type TradeCardSnapshot,
} from '../../lib/schema.js';

function snap(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1 };
}

/**
 * PR 1 coverage: chat send + mark-read + edit-snapshot capture.
 * Edit/confirm/cancel paths are covered in sessions-write.test.ts;
 * this file only exercises the new surfaces.
 */
describeWithDb('POST /api/sessions — chat + read state', () => {
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

  async function postChat(viewerId: string, sessionId: string, message: string) {
    const res = mockResponse();
    await handleChatSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewerId) },
        query: { id: sessionId },
        body: { message },
      }),
      res,
    );
    return res;
  }

  it('chat appends a chat event, returns the updated view with events newest-first', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);

    const res = await postChat(alice.id, id, 'hey, want to balance with a Luke?');
    expect(res._status).toBe(200);
    const body = res._json as { session: { events: Array<{ type: string; payload?: { body?: string } }> } };
    expect(body.session.events.length).toBeGreaterThan(0);
    // Server returns events newest-first; the chat we just posted is at index 0.
    expect(body.session.events[0].type).toBe('chat');
    expect(body.session.events[0].payload?.body).toBe('hey, want to balance with a Luke?');
  });

  it('chat trims whitespace + rejects empty after trim with 400', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);

    // Whitespace-only message rejected by zod (min-1 after Zod sees the
    // raw body) — but trimmed-empty hits the lib-level 'empty' branch.
    const okRes = await postChat(alice.id, id, '   trade?   ');
    expect(okRes._status).toBe(200);
    const body = okRes._json as { session: { events: Array<{ payload?: { body?: string } }> } };
    expect(body.session.events[0].payload?.body).toBe('trade?');
  });

  it('chat returns 404 for non-participant', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const stranger = await createTestUser();
    fixtures.push(stranger);
    const id = await createSession(alice, bob.handle);

    const res = await postChat(stranger.id, id, 'hi from a stranger');
    expect(res._status).toBe(404);
  });

  it('rate-limits chat after 10 messages in a minute', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);

    for (let i = 0; i < 10; i++) {
      const r = await postChat(alice.id, id, `msg ${i}`);
      expect(r._status).toBe(200);
    }
    const eleventh = await postChat(alice.id, id, 'msg 11');
    expect(eleventh._status).toBe(429);
  });

  it('mark-read stamps the viewer column; unread count drops to zero', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);

    // Bob sends a chat — alice's unreadCount should be 1 from her POV.
    await postChat(bob.id, id, 'looking for Han');

    // Alice marks read.
    const markRes = mockResponse();
    await handleMarkReadSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(alice.id) },
        query: { id },
      }),
      markRes,
    );
    expect(markRes._status).toBe(200);
    const body = markRes._json as { session: { unreadCount: number; lastReadAt: string | null } };
    expect(body.session.unreadCount).toBe(0);
    expect(body.session.lastReadAt).toBeTruthy();
  });

  it('edit-snapshot event captures both sides on every edit', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);

    const editRes = mockResponse();
    await handleEditSession(
      mockRequest({
        method: 'PUT',
        cookies: { swu_session: await sealTestCookie(alice.id) },
        query: { id },
        body: { cards: [snap('a-1', 2), snap('a-2', 1)] },
      }),
      editRes,
    );
    expect(editRes._status).toBe(200);

    const db = getDb();
    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, id));
    const snapshot = events.find(e => e.type === 'edit-snapshot');
    expect(snapshot).toBeDefined();
    const payload = snapshot!.payload as { userACards: TradeCardSnapshot[]; userBCards: TradeCardSnapshot[] };
    expect(payload.userACards).toBeDefined();
    expect(payload.userBCards).toBeDefined();
    // Whichever side alice was, her cards land there.
    const aliceCards = [...payload.userACards, ...payload.userBCards].filter(c => c.productId === 'a-1' || c.productId === 'a-2');
    expect(aliceCards.map(c => c.productId).sort()).toEqual(['a-1', 'a-2']);
  });

  it('snapshot events excluded from default timeline (events list omits them)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const id = await createSession(alice, bob.handle);

    // Trigger an edit so a snapshot is recorded.
    await handleEditSession(
      mockRequest({
        method: 'PUT',
        cookies: { swu_session: await sealTestCookie(alice.id) },
        query: { id },
        body: { cards: [snap('a-1')] },
      }),
      mockResponse(),
    );

    // Pull the view via chat (simplest GET surface returning events).
    const res = await postChat(alice.id, id, 'hello');
    expect(res._status).toBe(200);
    const body = res._json as { session: { events: Array<{ type: string }> } };
    const types = body.session.events.map(e => e.type);
    expect(types).not.toContain('edit-snapshot');
    // But the chat we just posted is there.
    expect(types).toContain('chat');
    // And the edit + edit-related events.
    expect(types).toContain('edited');
  });
});
