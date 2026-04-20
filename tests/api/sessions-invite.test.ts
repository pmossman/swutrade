import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleCreateOpenSession,
  handleInviteHandle,
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
  users,
  type TradeCardSnapshot,
} from '../../lib/schema.js';
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type SendCall } from './discordFakes.js';

function snap(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1 };
}

/**
 * Fake DiscordBotClient that records every `sendDirectMessage` call
 * the handler makes. Follows the pattern from tests/api/trades-edit.
 */
function makeFakeBot(): DiscordBotClient & { sendCalls: SendCall[] } {
  const sendCalls: SendCall[] = [];
  return Object.assign(
    createBaseFakeBot({
      async sendDirectMessage(userId, body) {
        sendCalls.push({ userId, body });
        return { id: 'msg-invite', channel_id: 'dm-invite' };
      },
    }),
    { sendCalls },
  );
}

/**
 * Coverage for POST /api/sessions/:id/invite-handle — the "invite by
 * handle" alternative to the QR / share-link affordance:
 *   - happy path DM send + event logged
 *   - 404 unknown handle
 *   - 403 non-creator
 *   - 400 self-invite
 *   - 409 session not open (slot B filled)
 *   - 403 ghost creator (needs Discord to originate)
 *   - debounce: second invite within the window → no duplicate DM
 */
describeWithDb('POST /api/sessions/:id/invite-handle', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdSessionIds: string[] = [];
  const ghostIdsToClean: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdSessionIds) {
      await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, id)).catch(() => {});
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

  async function createOpenSessionForCreator(
    creator: { id: string },
    initialCards: TradeCardSnapshot[] = [],
  ): Promise<string> {
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(creator.id) },
      body: { initialCards },
    });
    const res = mockResponse();
    await handleCreateOpenSession(req, res);
    const body = res._json as { id: string };
    createdSessionIds.push(body.id);
    return body.id;
  }

  it('happy path: creator invites a known handle → DM sent, notified event recorded, 200', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await createOpenSessionForCreator(alice, [snap('a-1')]);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: { handle: bob.handle },
      headers: { host: 'beta.swutrade.com' },
    });
    const res = mockResponse();
    await handleInviteHandle(req, res, { bot });

    expect(res._status).toBe(200);
    const payload = res._json as { invited: { userId: string; handle: string } };
    expect(payload.invited.userId).toBe(bob.id);
    expect(payload.invited.handle).toBe(bob.handle);

    // DM went to Bob's Discord id. `createTestUser` seeds discordId = id.
    expect(bot.sendCalls).toHaveLength(1);
    expect(bot.sendCalls[0].userId).toBe(bob.id);
    const embed = bot.sendCalls[0].body.embeds?.[0];
    expect(embed?.title).toBe('Shared trade invite');
    // Description mentions the session URL so the recipient knows
    // where they're heading.
    expect(embed?.description ?? '').toContain(`/s/${sessionId}`);
    expect(embed?.description ?? '').toContain(`@${alice.handle}`);

    // Notified event with the invite payload is recorded.
    const db = getDb();
    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId));
    const invited = events.find(e => {
      const p = e.payload as { kind?: string } | null;
      return e.type === 'notified' && p?.kind === 'invite';
    });
    expect(invited).toBeDefined();
    expect(invited?.actorUserId).toBe(alice.id);
    expect(invited?.payload).toMatchObject({
      kind: 'invite',
      targetHandle: bob.handle,
      targetUserId: bob.id,
    });
  });

  it('404 when the target handle does not exist', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const sessionId = await createOpenSessionForCreator(alice);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: { handle: 'nonexistenthandle999' },
    });
    const res = mockResponse();
    await handleInviteHandle(req, res, { bot });

    expect(res._status).toBe(404);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('403 when a non-creator tries to invite', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const carol = await createTestUser();
    fixtures.push(carol);
    const sessionId = await createOpenSessionForCreator(alice);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      // Bob (not the creator) tries to invite Carol.
      cookies: { swu_session: await sealTestCookie(bob.id) },
      query: { id: sessionId },
      body: { handle: carol.handle },
    });
    const res = mockResponse();
    await handleInviteHandle(req, res, { bot });

    expect(res._status).toBe(403);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('400 when the creator tries to invite themselves', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const sessionId = await createOpenSessionForCreator(alice);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: { handle: alice.handle },
    });
    const res = mockResponse();
    await handleInviteHandle(req, res, { bot });

    expect(res._status).toBe(400);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('409 when the session already has both slots filled (not open)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const carol = await createTestUser();
    fixtures.push(carol);
    const sessionId = await createOpenSessionForCreator(alice);

    // Force the session closed — flip user_b_id to a real user so
    // the "open slot" invariant fails.
    const db = getDb();
    await db
      .update(tradeSessions)
      .set({ userBId: bob.id })
      .where(eq(tradeSessions.id, sessionId));

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: { handle: carol.handle },
    });
    const res = mockResponse();
    await handleInviteHandle(req, res, { bot });

    expect(res._status).toBe(409);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('403 when a ghost creator tries to invite by handle (needs sign-in)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);

    // Anonymous create-open path — mints a ghost creator + cookie.
    const createReq = mockRequest({
      method: 'POST',
      body: { initialCards: [snap('a-1')] },
    });
    const createRes = mockResponse();
    await handleCreateOpenSession(createReq, createRes);
    expect(createRes._status).toBe(201);
    const createBody = createRes._json as {
      id: string;
      ghost: { id: string; handle: string; username: string } | null;
    };
    createdSessionIds.push(createBody.id);
    expect(createBody.ghost).not.toBeNull();
    if (createBody.ghost) ghostIdsToClean.push(createBody.ghost.id);

    // Now seal a ghost cookie and attempt an invite.
    const ghostCookie = await sealTestCookie(createBody.ghost!.id, { isAnonymous: true });
    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: ghostCookie },
      query: { id: createBody.id },
      body: { handle: alice.handle },
    });
    const res = mockResponse();
    await handleInviteHandle(req, res, { bot });

    expect(res._status).toBe(403);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('debounce: a second invite for the same handle within the window is a no-op (no duplicate DM)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await createOpenSessionForCreator(alice);

    const bot = makeFakeBot();
    // First invite — DM sent.
    const req1 = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: { handle: bob.handle },
    });
    const res1 = mockResponse();
    await handleInviteHandle(req1, res1, { bot });
    expect(res1._status).toBe(200);
    expect(bot.sendCalls).toHaveLength(1);

    // Second invite (same handle) immediately after — debounced.
    const req2 = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: { handle: bob.handle },
    });
    const res2 = mockResponse();
    await handleInviteHandle(req2, res2, { bot });
    expect(res2._status).toBe(200);
    // No new DM.
    expect(bot.sendCalls).toHaveLength(1);

    // The debounced attempt logs a breadcrumb event (`invite-debounced`)
    // so the timeline explains why no second DM fired.
    const db = getDb();
    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId));
    const kinds = events.map(e => {
      const p = e.payload as { kind?: string } | null;
      return p?.kind ?? null;
    });
    expect(kinds).toContain('invite');
    expect(kinds).toContain('invite-debounced');
  });
});
