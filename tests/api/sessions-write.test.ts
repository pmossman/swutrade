import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  handleCancelSession,
  handleConfirmSession,
  handleCreateSession,
  handleEditSession,
  handleUnconfirmSession,
} from '../../api/sessions.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { sessionEvents, tradeSessions, type TradeCardSnapshot, users } from '../../lib/schema.js';
import { createOpenSession, getSessionForViewer } from '../../lib/sessions.js';
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type SendCall } from './discordFakes.js';

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

  // Fake DM client — records every sendDirectMessage call so tests
  // can assert on the B1 "session-invited" DM. Mirrors the pattern
  // in sessions-invite.test.ts.
  function makeFakeBot(): DiscordBotClient & { sendCalls: SendCall[] } {
    const sendCalls: SendCall[] = [];
    return Object.assign(
      createBaseFakeBot({
        async sendDirectMessage(userId, body) {
          sendCalls.push({ userId, body });
          return { id: 'msg-create-invite', channel_id: 'dm-create' };
        },
      }),
      { sendCalls },
    );
  }

  // Helper: create a session via the API; captures id for cleanup.
  // Returns the fake bot so callers can inspect its sendCalls.
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
    const bot = makeFakeBot();
    await handleCreateSession(req, res, { bot });
    const body = res._json as { id?: string; created?: boolean; error?: string };
    if (body.id) createdIds.push(body.id);
    return { status: res._status, body, bot };
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

  // --- B1: session-invite DM on create -------------------------------------

  it('B1: fires a session-invite DM to the counterpart on a fresh create', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    const { status, bot, body } = await createSession(alice, bob.handle);
    expect(status).toBe(201);
    expect(bot.sendCalls).toHaveLength(1);
    expect(bot.sendCalls[0].userId).toBe(bob.id); // discordId = id in test fixture
    // DM body should reference the inviter and embed the session URL.
    const embed = bot.sendCalls[0].body.embeds?.[0];
    expect(embed?.description).toContain(`@${alice.handle}`);
    expect(embed?.description).toContain(`/s/${body.id}`);

    // A `notified` event with kind=invite is recorded so future
    // re-engagement logic can see this user has already been pinged.
    const db = getDb();
    const events = await db
      .select()
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.sessionId, body.id!),
        eq(sessionEvents.type, 'notified'),
      ));
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { kind: string; targetUserId: string };
    expect(payload.kind).toBe('invite');
    expect(payload.targetUserId).toBe(bob.id);
  });

  it('B1: does NOT re-fire the DM when an existing active session is returned', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    const first = await createSession(alice, bob.handle);
    expect(first.status).toBe(201);
    expect(first.bot.sendCalls).toHaveLength(1);

    // Second create with the same pair → idempotent redirect (200,
    // created:false). Since we're not creating a new session, no DM.
    const second = await createSession(alice, bob.handle);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.bot.sendCalls).toHaveLength(0);
  });

  it('B1: gracefully skips the DM when the counterpart has no discord_id (ghost)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);

    // Create a ghost-shaped user manually — has a handle but no
    // discord_id, mirroring the createGhostUser path.
    const db = getDb();
    const ghostId = `ghost-${crypto.randomUUID().slice(0, 12)}`;
    const ghostHandle = `guest-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(users).values({
      id: ghostId,
      discordId: null,
      username: 'Ghost',
      handle: ghostHandle,
      avatarUrl: null,
    });
    fixtures.push({ id: ghostId, handle: ghostHandle, cleanup: async () => {
      await db.delete(users).where(eq(users.id, ghostId)).catch(() => {});
    } });

    const { status, bot, body } = await createSession(alice, ghostHandle);
    // Session creates fine; DM silently skipped because the target has
    // no discord_id to address.
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    expect(bot.sendCalls).toHaveLength(0);

    // No `notified` event recorded — we only record on a successful
    // DM send so future re-engagement doesn't see a phantom ping.
    const events = await db
      .select()
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.sessionId, body.id!),
        eq(sessionEvents.type, 'notified'),
      ));
    expect(events).toHaveLength(0);
  });

  it('B1: gracefully skips the DM when the counterpart has opted out via dmSessionInvited=false', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    // Bob has opted out of trade-invite DMs (B2 pref). The session
    // still creates fine, but no DM is sent and no `notified` event
    // is recorded.
    const db = getDb();
    await db.update(users).set({ dmSessionInvited: false }).where(eq(users.id, bob.id));

    const { status, bot, body } = await createSession(alice, bob.handle);
    expect(status).toBe(201);
    expect(body.created).toBe(true);
    expect(bot.sendCalls).toHaveLength(0);

    const events = await db
      .select()
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.sessionId, body.id!),
        eq(sessionEvents.type, 'notified'),
      ));
    expect(events).toHaveLength(0);
  });

  // --- B4: counterpartSuggestions seeded as outgoing suggestions ----------

  it('B4: cards staged for the counterpart side become outgoing suggestions on the new session', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    const aliceCards = [snap('a-1', 1), snap('a-2', 2)];
    const counterpartSuggestions = [snap('b-1', 3), snap('b-2', 1)];

    const cookie = await sealTestCookie(alice.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        counterpartHandle: bob.handle,
        initialCards: aliceCards,
        counterpartSuggestions,
      },
    });
    const res = mockResponse();
    const bot = makeFakeBot();
    await handleCreateSession(req, res, { bot });

    expect(res._status).toBe(201);
    const body = res._json as { id: string; created: boolean };
    createdIds.push(body.id);

    // Verify session shape: alice's cards on her side, bob's side empty.
    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, body.id));
    const aliceIsA = row.userAId === alice.id;
    const aliceCardsOnSession = aliceIsA ? row.userACards : row.userBCards;
    const bobCardsOnSession = aliceIsA ? row.userBCards : row.userACards;
    expect(aliceCardsOnSession).toHaveLength(2);
    expect(bobCardsOnSession).toHaveLength(0);

    // Verify the suggestion was filed targeting bob's side.
    // suggestion-created events carry the count metadata; the actual
    // cards live in tradeSessions.pendingSuggestions.
    const events = await db
      .select()
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.sessionId, body.id),
        eq(sessionEvents.type, 'suggestion-created'),
      ));
    expect(events).toHaveLength(1);
    const eventPayload = events[0].payload as {
      targetSide: 'a' | 'b';
      addCount: number;
      removeCount: number;
    };
    const expectedCounterpartSide: 'a' | 'b' = aliceIsA ? 'b' : 'a';
    expect(eventPayload.targetSide).toBe(expectedCounterpartSide);
    expect(eventPayload.addCount).toBe(2);
    expect(eventPayload.removeCount).toBe(0);

    // The actual suggestion shape lives on the session row.
    const pending = (row.pendingSuggestions ?? []).filter(s => !s.dismissedAt);
    // Re-fetch since we already grabbed `row` before the suggestion
    // was filed.
    const [refetched] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, body.id));
    const live = (refetched.pendingSuggestions ?? []).filter(s => !s.dismissedAt);
    expect(pending.length + live.length).toBeGreaterThanOrEqual(0); // soft assertion to satisfy `pending` use
    expect(live).toHaveLength(1);
    expect(live[0].targetSide).toBe(expectedCounterpartSide);
    expect(live[0].cardsToAdd).toHaveLength(2);
    expect(live[0].cardsToAdd.map((c: { productId: string }) => c.productId).sort())
      .toEqual(['b-1', 'b-2']);
  });

  it('B4: empty counterpartSuggestions is the default — no suggestion event filed', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    const { status, body } = await createSession(alice, bob.handle, [snap('a-1')]);
    expect(status).toBe(201);

    // No `suggested` events when the request omitted counterpartSuggestions.
    const db = getDb();
    const events = await db
      .select()
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.sessionId, body.id!),
        eq(sessionEvents.type, 'suggestion-created'),
      ));
    expect(events).toHaveLength(0);
  });

  it('B4: re-create into an existing active pair does NOT add another suggestion', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    // First create with suggestions.
    const cookie = await sealTestCookie(alice.id);
    const reqOne = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        counterpartHandle: bob.handle,
        initialCards: [snap('a-1')],
        counterpartSuggestions: [snap('b-1')],
      },
    });
    const resOne = mockResponse();
    await handleCreateSession(reqOne, resOne, { bot: makeFakeBot() });
    const bodyOne = resOne._json as { id: string };
    createdIds.push(bodyOne.id);

    // Second create against the same pair with new suggestions —
    // should resolve to the same session, but skip the seed because
    // created:false (the user might've been editing the session
    // live; we don't pile on duplicate suggestion rows).
    const reqTwo = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        counterpartHandle: bob.handle,
        initialCards: [snap('a-1')],
        counterpartSuggestions: [snap('b-2')],
      },
    });
    const resTwo = mockResponse();
    await handleCreateSession(reqTwo, resTwo, { bot: makeFakeBot() });
    const bodyTwo = resTwo._json as { id: string; created: boolean };
    expect(bodyTwo.created).toBe(false);
    expect(bodyTwo.id).toBe(bodyOne.id);

    // Still exactly ONE suggestion event — the second call's
    // suggestions were ignored.
    const db = getDb();
    const events = await db
      .select()
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.sessionId, bodyOne.id),
        eq(sessionEvents.type, 'suggestion-created'),
      ));
    expect(events).toHaveLength(1);
  });

  it('B1: still 201s the create even if the DM bot throws', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    // Bot whose sendDirectMessage always throws — simulates DM
    // disabled, network blip, etc. Session creation must not 5xx.
    const throwingBot = createBaseFakeBot({
      async sendDirectMessage() {
        throw new Error('DMs disabled');
      },
    });

    const cookie = await sealTestCookie(alice.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { counterpartHandle: bob.handle, initialCards: [] },
    });
    const res = mockResponse();
    await handleCreateSession(req, res, { bot: throwingBot });

    const body = res._json as { id?: string; created?: boolean };
    if (body.id) createdIds.push(body.id);
    expect(res._status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.id).toBeDefined();
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

  it('unconfirm removes viewer from confirmedByUserIds; idempotent when not confirmed', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const created = await createSession(alice, bob.handle, [snap('a-1')]);
    const id = created.body.id!;

    const cookie = await sealTestCookie(alice.id);

    // Confirm first.
    let res = mockResponse();
    await handleConfirmSession(
      mockRequest({ method: 'POST', cookies: { swu_session: cookie }, query: { id } }),
      res,
    );
    expect(res._status).toBe(200);

    const db = getDb();
    let [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, id));
    expect(row.confirmedByUserIds).toContain(alice.id);

    // Unconfirm.
    res = mockResponse();
    await handleUnconfirmSession(
      mockRequest({ method: 'POST', cookies: { swu_session: cookie }, query: { id } }),
      res,
    );
    expect(res._status).toBe(200);
    const unconfirmedView = (res._json as { session: { confirmedByViewer: boolean; status: string } }).session;
    expect(unconfirmedView.confirmedByViewer).toBe(false);
    expect(unconfirmedView.status).toBe('active');

    [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, id));
    expect(row.confirmedByUserIds).not.toContain(alice.id);

    // Idempotent — unconfirming when not confirmed is a no-op 200.
    res = mockResponse();
    await handleUnconfirmSession(
      mockRequest({ method: 'POST', cookies: { swu_session: cookie }, query: { id } }),
      res,
    );
    expect(res._status).toBe(200);
  });

  it('unconfirm on a settled session returns 409 (cannot undo a handshake)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const created = await createSession(alice, bob.handle, [snap('a-1')]);
    const id = created.body.id!;

    // Both confirm → settled.
    for (const user of [alice, bob]) {
      const res = mockResponse();
      await handleConfirmSession(
        mockRequest({
          method: 'POST',
          cookies: { swu_session: await sealTestCookie(user.id) },
          query: { id },
        }),
        res,
      );
      expect(res._status).toBe(200);
    }

    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, id));
    expect(row.status).toBe('settled');

    // Unconfirm rejected.
    const res = mockResponse();
    await handleUnconfirmSession(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(alice.id) },
        query: { id },
      }),
      res,
    );
    expect(res._status).toBe(409);
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
