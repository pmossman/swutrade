import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { handlePingSession } from '../../api/sessions.js';
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
import { createOrGetActiveSession, recordSessionEvent } from '../../lib/sessions.js';
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type SendCall } from './discordFakes.js';

function snap(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1 };
}

function makeFakeBot(): DiscordBotClient & { sendCalls: SendCall[] } {
  const sendCalls: SendCall[] = [];
  return Object.assign(
    createBaseFakeBot({
      async sendDirectMessage(userId, body) {
        sendCalls.push({ userId, body });
        return { id: 'msg-ping', channel_id: 'dm-ping' };
      },
    }),
    { sendCalls },
  );
}

/**
 * Coverage for POST /api/sessions/:id/ping (Phase B2).
 *
 * Surfaces tested:
 *   - happy path: viewer pings → DM goes to counterpart, event logged
 *   - optional `note` carried through into the DM body
 *   - rate-limit: second ping inside the window 429s, no DM
 *   - validation: 403 non-participant, 409 open-slot / terminal,
 *     409 counterpart-no-discord-id / opted-out, 400 note too long
 *
 * Pre-Discord pref-gate is exercised here: a counterpart with
 * `dmSessionPing=false` collapses to `opted-out` server-side, which
 * is a 409 with a friendly message. The session itself is unaffected.
 */
describeWithDb('POST /api/sessions/:id/ping', () => {
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

  // Bypass the create handler (which fires its own DM) and seed the
  // session via the lib helper directly so per-test bot.sendCalls is
  // strictly the ping's contribution.
  async function seedActivePair(
    alice: { id: string },
    bob: { id: string },
    aliceCards: TradeCardSnapshot[] = [],
  ): Promise<string> {
    const db = getDb();
    const result = await createOrGetActiveSession(db, {
      creatorUserId: alice.id,
      counterpartUserId: bob.id,
      creatorCards: aliceCards,
    });
    createdSessionIds.push(result.id);
    return result.id;
  }

  it('happy path: viewer pings → DM to counterpart, notified event recorded, 200', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob, [snap('a-1')]);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: {},
      headers: { host: 'beta.swutrade.com' },
    });
    const res = mockResponse();
    await handlePingSession(req, res, { bot });

    expect(res._status).toBe(200);
    const payload = res._json as { pinged: { userId: string } };
    expect(payload.pinged.userId).toBe(bob.id);

    expect(bot.sendCalls).toHaveLength(1);
    expect(bot.sendCalls[0].userId).toBe(bob.id);
    const embed = bot.sendCalls[0].body.embeds?.[0];
    expect(embed?.title).toBe('Ping from a counterpart');
    expect(embed?.description ?? '').toContain(`@${alice.handle}`);
    expect(embed?.description ?? '').toContain(`/s/${sessionId}`);

    // notified event recorded with kind=ping. The rate-limit check
    // looks for these on subsequent pings.
    const db = getDb();
    const events = await db
      .select()
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.sessionId, sessionId),
        eq(sessionEvents.type, 'notified'),
      ));
    expect(events).toHaveLength(1);
    const p = events[0].payload as { kind: string; senderUserId: string; targetUserId: string };
    expect(p.kind).toBe('ping');
    expect(p.senderUserId).toBe(alice.id);
    expect(p.targetUserId).toBe(bob.id);
  });

  it('embeds an optional note in the DM body', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: { note: 'mind taking another look at the Bossk?' },
    });
    const res = mockResponse();
    await handlePingSession(req, res, { bot });

    expect(res._status).toBe(200);
    expect(bot.sendCalls[0].body.embeds?.[0].description ?? '')
      .toContain('mind taking another look at the Bossk?');
  });

  it('429 rate-limited: second ping inside the window does not DM', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    const bot = makeFakeBot();
    const req1 = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: {},
    });
    await handlePingSession(req1, mockResponse(), { bot });
    expect(bot.sendCalls).toHaveLength(1);

    const req2 = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: {},
    });
    const res2 = mockResponse();
    await handlePingSession(req2, res2, { bot });
    expect(res2._status).toBe(429);
    // Still only one DM total — second call collapsed to rate-limited.
    expect(bot.sendCalls).toHaveLength(1);
  });

  it('403 when the viewer is not a participant', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const carol = await createTestUser();
    fixtures.push(carol);
    const sessionId = await seedActivePair(alice, bob);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(carol.id) },
      query: { id: sessionId },
      body: {},
    });
    const res = mockResponse();
    await handlePingSession(req, res, { bot });
    expect(res._status).toBe(403);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('409 no-counterpart on an open-slot session (slot B still null)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);

    // Open-slot session: userBId stays null until claimed.
    const db = getDb();
    const id = `S-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await db.insert(tradeSessions).values({
      id,
      userAId: alice.id,
      userBId: null,
      userACards: [],
      userBCards: [],
      status: 'active',
      confirmedByUserIds: [],
      lastEditedByUserId: null,
      lastNotifiedAt: {},
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    createdSessionIds.push(id);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id },
      body: {},
    });
    const res = mockResponse();
    await handlePingSession(req, res, { bot });
    expect(res._status).toBe(409);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('409 terminal: settled / cancelled / expired sessions reject the ping', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    // Force the session into terminal state.
    const db = getDb();
    await db
      .update(tradeSessions)
      .set({ status: 'cancelled' })
      .where(eq(tradeSessions.id, sessionId));

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: {},
    });
    const res = mockResponse();
    await handlePingSession(req, res, { bot });
    expect(res._status).toBe(409);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('409 opted-out when counterpart has dmSessionPing=false', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    // Bob opts out of ping DMs.
    const db = getDb();
    await db.update(users).set({ dmSessionPing: false }).where(eq(users.id, bob.id));

    const sessionId = await seedActivePair(alice, bob);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: {},
    });
    const res = mockResponse();
    await handlePingSession(req, res, { bot });
    expect(res._status).toBe(409);
    const err = res._json as { error: string };
    expect(err.error).toContain('turned off');
    expect(bot.sendCalls).toHaveLength(0);

    // Critical: no `notified` event when opted-out, so rate-limit
    // window doesn't get poisoned by silent skips.
    const events = await db
      .select()
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.sessionId, sessionId),
        eq(sessionEvents.type, 'notified'),
      ));
    expect(events).toHaveLength(0);
  });

  it('409 no-discord-id when counterpart is a ghost without Discord identity', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);

    // Hand-build a ghost — no discord_id, has handle.
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
    fixtures.push({
      id: ghostId,
      handle: ghostHandle,
      cleanup: async () => {
        await db.delete(users).where(eq(users.id, ghostId)).catch(() => {});
      },
    });

    const sessionId = await seedActivePair(alice, { id: ghostId });

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: {},
    });
    const res = mockResponse();
    await handlePingSession(req, res, { bot });
    expect(res._status).toBe(409);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('400 note-too-long when payload exceeds the cap', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    const bot = makeFakeBot();
    const longNote = 'x'.repeat(500); // way over the 200-char cap
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: { note: longNote },
    });
    const res = mockResponse();
    await handlePingSession(req, res, { bot });
    expect(res._status).toBe(400);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('opted-out marker does not poison the rate-limit window — sender can re-ping after the recipient opts back in', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    // Bob is opted out at first.
    const db = getDb();
    await db.update(users).set({ dmSessionPing: false }).where(eq(users.id, bob.id));
    const sessionId = await seedActivePair(alice, bob);

    const bot = makeFakeBot();
    const req1 = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: {},
    });
    const res1 = mockResponse();
    await handlePingSession(req1, res1, { bot });
    expect(res1._status).toBe(409);

    // Bob opts back in.
    await db.update(users).set({ dmSessionPing: true }).where(eq(users.id, bob.id));

    // Alice's next ping should NOT be rate-limited — the opted-out
    // first call didn't record a notified event.
    const req2 = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(alice.id) },
      query: { id: sessionId },
      body: {},
    });
    const res2 = mockResponse();
    await handlePingSession(req2, res2, { bot });
    expect(res2._status).toBe(200);
    expect(bot.sendCalls).toHaveLength(1);

    // Suppress unused-import warning for recordSessionEvent — tests
    // exercise it indirectly through the ping helper.
    void recordSessionEvent;
  });
});
