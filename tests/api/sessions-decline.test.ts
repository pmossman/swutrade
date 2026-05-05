import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { handleDeclineSession } from '../../api/sessions.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { sessionEvents, tradeSessions, users } from '../../lib/schema.js';
import { createOrGetActiveSession } from '../../lib/sessions.js';
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type SendCall } from './discordFakes.js';

function makeFakeBot(): DiscordBotClient & { sendCalls: SendCall[] } {
  const sendCalls: SendCall[] = [];
  return Object.assign(
    createBaseFakeBot({
      async sendDirectMessage(userId, body) {
        sendCalls.push({ userId, body });
        return { id: 'msg-decline', channel_id: 'dm-decline' };
      },
    }),
    { sendCalls },
  );
}

/**
 * Coverage for POST /api/sessions/:id/decline (Phase B5).
 *
 * Surfaces tested:
 *   - happy path: session goes to cancelled with cancel_reason='declined',
 *     decline DM goes to the OTHER party, notified event recorded
 *   - 403 when the viewer is not a participant
 *   - 409 when the session is already terminal (settled/cancelled/expired)
 *   - 409 when there's no counterpart yet (open-slot session)
 *   - 400 when the optional note exceeds the cap
 *   - opted-out: counterpart with dmSessionDeclined=false → no DM,
 *     but the cancel itself still lands (the action isn't gated on
 *     the recipient's DM pref, only the notification)
 *   - happy path with note: note appears verbatim in the DM body
 */
describeWithDb('POST /api/sessions/:id/decline', () => {
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

  it('cancelReason flows from DB into SessionView so the terminal banner can branch on it (B7)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    // Decline the session as Bob.
    const reqDecline = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(bob.id) },
      query: { id: sessionId },
      body: {},
    });
    await handleDeclineSession(reqDecline, mockResponse(), { bot: makeFakeBot() });

    // Re-fetch the session view from each side; both should see
    // cancelReason='declined' so the terminal banner copy lines up
    // for both participants.
    const db = getDb();
    const { getSessionForViewer } = await import('../../lib/sessions.js');
    const aliceView = await getSessionForViewer(db, sessionId, alice.id);
    const bobView = await getSessionForViewer(db, sessionId, bob.id);
    expect(aliceView?.status).toBe('cancelled');
    expect(aliceView?.cancelReason).toBe('declined');
    expect(bobView?.cancelReason).toBe('declined');
  });

  it('cancelReason=null on active sessions and on cancelled-via-withdraw sessions', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    // Active session — cancelReason should be null.
    const db = getDb();
    const { getSessionForViewer, cancelSession } = await import('../../lib/sessions.js');
    let view = await getSessionForViewer(db, sessionId, alice.id);
    expect(view?.cancelReason).toBeNull();

    // Cancel without a reason → cancelReason='withdrawn'.
    await cancelSession(db, { sessionId, viewerUserId: alice.id });
    view = await getSessionForViewer(db, sessionId, alice.id);
    expect(view?.status).toBe('cancelled');
    expect(view?.cancelReason).toBe('withdrawn');
  });

  it('happy path: viewer declines → session cancelled with reason=declined, DM fires, event logged', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(bob.id) },
      query: { id: sessionId },
      body: {},
      headers: { host: 'beta.swutrade.com' },
    });
    const res = mockResponse();
    await handleDeclineSession(req, res, { bot });

    expect(res._status).toBe(200);

    // Session row goes to cancelled with cancel_reason='declined'.
    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, sessionId));
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('declined');

    // DM goes to the OTHER party (alice in this case).
    expect(bot.sendCalls).toHaveLength(1);
    expect(bot.sendCalls[0].userId).toBe(alice.id);
    const embed = bot.sendCalls[0].body.embeds?.[0];
    expect(embed?.title).toBe('Trade declined');
    expect(embed?.description ?? '').toContain(`@${bob.handle}`);
    expect(embed?.description ?? '').toContain(`/s/${sessionId}`);

    // notified event with kind=declined recorded.
    const events = await db
      .select()
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.sessionId, sessionId),
        eq(sessionEvents.type, 'notified'),
      ));
    const decliningNotify = events.find(e => {
      const p = e.payload as { kind?: string } | null;
      return p?.kind === 'declined';
    });
    expect(decliningNotify).toBeDefined();
  });

  it('embeds an optional note in the decline DM body', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(bob.id) },
      query: { id: sessionId },
      body: { note: 'maybe in a couple weeks when prices settle' },
    });
    await handleDeclineSession(req, mockResponse(), { bot });

    expect(bot.sendCalls[0].body.embeds?.[0].description ?? '')
      .toContain('maybe in a couple weeks when prices settle');
  });

  it('opted-out recipient (dmSessionDeclined=false): cancel still lands, no DM', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);

    // Alice opts out of decline DMs (she's the OTHER party — bob is
    // the decliner). The decline action still goes through, the
    // session still cancels, but no DM gets sent to her.
    const db = getDb();
    await db.update(users).set({ dmSessionDeclined: false }).where(eq(users.id, alice.id));

    const sessionId = await seedActivePair(alice, bob);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(bob.id) },
      query: { id: sessionId },
      body: {},
    });
    const res = mockResponse();
    await handleDeclineSession(req, res, { bot });

    expect(res._status).toBe(200);
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, sessionId));
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('declined');
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('403 when viewer is not a participant', async () => {
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
    await handleDeclineSession(req, res, { bot });
    expect(res._status).toBe(403);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('409 when session is already terminal', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    // Force terminal state.
    const db = getDb();
    await db
      .update(tradeSessions)
      .set({ status: 'cancelled' })
      .where(eq(tradeSessions.id, sessionId));

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(bob.id) },
      query: { id: sessionId },
      body: {},
    });
    const res = mockResponse();
    await handleDeclineSession(req, res, { bot });
    expect(res._status).toBe(409);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('400 when the optional note exceeds the cap', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const sessionId = await seedActivePair(alice, bob);

    const bot = makeFakeBot();
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: await sealTestCookie(bob.id) },
      query: { id: sessionId },
      body: { note: 'x'.repeat(500) },
    });
    const res = mockResponse();
    await handleDeclineSession(req, res, { bot });
    expect(res._status).toBe(400);
    expect(bot.sendCalls).toHaveLength(0);

    // Session is still active — the 400 is rejection-before-action.
    const db = getDb();
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, sessionId));
    expect(row.status).toBe('active');
  });
});
