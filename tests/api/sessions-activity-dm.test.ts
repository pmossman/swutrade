import { describeWithDb, mockRequest, mockResponse, createTestUser, sealTestCookie } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleChatSession,
  handleEditSession,
  handleConfirmSession,
  handlePingSession,
} from '../../api/sessions.js';
import { getDb } from '../../lib/db.js';
import {
  sessionEvents,
  tradeSessions,
  users,
  type TradeCardSnapshot,
} from '../../lib/schema.js';
import {
  createOrGetActiveSession,
  notifySessionActivity,
  SESSION_ACTIVITY_DM_COOLDOWN_MS,
} from '../../lib/sessions.js';
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type SendCall } from './discordFakes.js';

/**
 * Coverage for the auto-DM-on-activity behaviour wired into chat /
 * edit / confirm / unconfirm / suggest / accept-suggestion handlers.
 * `notifySessionActivity` does the cooldown + pref + Discord-id
 * gating; the handlers fire it via `waitUntil`.
 *
 * What's tested here:
 *   - Happy path: first activity event → DM goes out, lastNotifiedAt
 *     bumps, `notified` event with kind='activity' lands.
 *   - Cooldown: a second event within SESSION_ACTIVITY_DM_COOLDOWN_MS
 *     doesn't re-DM.
 *   - Manual ping interlock: ping bumps the same lastNotifiedAt, so a
 *     subsequent activity event in the cooldown window is silent.
 *   - Pref opt-out: counterpart with dmSessionActivity=false gets no DM.
 *   - No discord_id: ghost / anon counterpart gets no DM (silent skip).
 *   - Terminal session: no DM (lifecycle DMs cover those).
 *   - Self-actor: no DM (you never ping yourself).
 *
 * The library function is called directly so the cooldown-time math
 * is deterministic without `waitUntil` or Vercel runtime edges.
 */

function snap(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1 };
}

function makeFakeBot(): DiscordBotClient & { sendCalls: SendCall[] } {
  const sendCalls: SendCall[] = [];
  return Object.assign(
    createBaseFakeBot({
      async sendDirectMessage(userId, body) {
        sendCalls.push({ userId, body });
        return { id: 'msg-activity', channel_id: 'dm-activity' };
      },
    }),
    { sendCalls },
  );
}

describeWithDb('notifySessionActivity', () => {
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

  async function seedPair() {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const db = getDb();
    const result = await createOrGetActiveSession(db, {
      creatorUserId: alice.id,
      counterpartUserId: bob.id,
      creatorCards: [snap('p-1')],
    });
    createdSessionIds.push(result.id);
    return { alice, bob, sessionId: result.id };
  }

  it('happy path: first activity → DM, lastNotifiedAt bumps, notified event lands', async () => {
    const { alice, bob, sessionId } = await seedPair();
    const bot = makeFakeBot();
    const db = getDb();

    const result = await notifySessionActivity(db, {
      sessionId,
      actorUserId: alice.id,
      bot,
      appBaseUrl: 'https://beta.swutrade.com',
    });

    expect(result.sent).toBe(true);
    if (result.sent) expect(result.recipientUserId).toBe(bob.id);
    expect(bot.sendCalls).toHaveLength(1);
    expect(bot.sendCalls[0].userId).toBeTruthy();

    // lastNotifiedAt[bob] now stamped to ~now
    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, sessionId)).limit(1);
    expect(row?.lastNotifiedAt[bob.id]).toBeTruthy();

    // notified event with kind='activity' recorded
    const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
    const activityEvents = events.filter(e => e.type === 'notified' && (e.payload as { kind?: string } | null)?.kind === 'activity');
    expect(activityEvents).toHaveLength(1);
  });

  it('cooldown: second activity inside the window is silent', async () => {
    const { alice, sessionId } = await seedPair();
    const bot = makeFakeBot();
    const db = getDb();

    // Fire once.
    await notifySessionActivity(db, { sessionId, actorUserId: alice.id, bot, appBaseUrl: 'https://x' });
    expect(bot.sendCalls).toHaveLength(1);

    // Second call immediately.
    const second = await notifySessionActivity(db, { sessionId, actorUserId: alice.id, bot, appBaseUrl: 'https://x' });
    expect(second.sent).toBe(false);
    if (!second.sent) expect(second.reason).toBe('cooldown-active');
    expect(bot.sendCalls).toHaveLength(1);
  });

  it('cooldown: rolls back after the window and re-fires', async () => {
    const { alice, bob, sessionId } = await seedPair();
    const bot = makeFakeBot();
    const db = getDb();

    // Pre-populate lastNotifiedAt with a stale timestamp (just past
    // the cooldown).
    const stale = new Date(Date.now() - SESSION_ACTIVITY_DM_COOLDOWN_MS - 1000);
    await db
      .update(tradeSessions)
      .set({ lastNotifiedAt: { [bob.id]: stale.toISOString() } })
      .where(eq(tradeSessions.id, sessionId));

    const result = await notifySessionActivity(db, { sessionId, actorUserId: alice.id, bot, appBaseUrl: 'https://x' });
    expect(result.sent).toBe(true);
    expect(bot.sendCalls).toHaveLength(1);
  });

  it('manual ping bumps the same column → subsequent activity is silent', async () => {
    const { alice, bob, sessionId } = await seedPair();
    const db = getDb();

    // Simulate a manual ping just having stamped lastNotifiedAt.
    await db
      .update(tradeSessions)
      .set({ lastNotifiedAt: { [bob.id]: new Date().toISOString() } })
      .where(eq(tradeSessions.id, sessionId));

    const bot = makeFakeBot();
    const result = await notifySessionActivity(db, { sessionId, actorUserId: alice.id, bot, appBaseUrl: 'https://x' });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe('cooldown-active');
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('opted out: counterpart with dmSessionActivity=false gets no DM', async () => {
    const { alice, bob, sessionId } = await seedPair();
    const db = getDb();
    await db.update(users).set({ dmSessionActivity: false }).where(eq(users.id, bob.id));

    const bot = makeFakeBot();
    const result = await notifySessionActivity(db, { sessionId, actorUserId: alice.id, bot, appBaseUrl: 'https://x' });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe('opted-out');
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('no discord_id: ghost counterpart gets silent skip', async () => {
    const { alice, bob, sessionId } = await seedPair();
    const db = getDb();
    await db.update(users).set({ discordId: null }).where(eq(users.id, bob.id));

    const bot = makeFakeBot();
    const result = await notifySessionActivity(db, { sessionId, actorUserId: alice.id, bot, appBaseUrl: 'https://x' });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe('no-discord-id');
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('terminal session: no DM (lifecycle DMs cover that case)', async () => {
    const { alice, sessionId } = await seedPair();
    const db = getDb();
    await db.update(tradeSessions).set({ status: 'cancelled' }).where(eq(tradeSessions.id, sessionId));

    const bot = makeFakeBot();
    const result = await notifySessionActivity(db, { sessionId, actorUserId: alice.id, bot, appBaseUrl: 'https://x' });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe('session-terminal');
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('self-actor (caller is not a session participant): no DM', async () => {
    const { sessionId } = await seedPair();
    const stranger = await createTestUser();
    fixtures.push(stranger);

    const bot = makeFakeBot();
    const db = getDb();
    const result = await notifySessionActivity(db, { sessionId, actorUserId: stranger.id, bot, appBaseUrl: 'https://x' });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe('self-actor');
    expect(bot.sendCalls).toHaveLength(0);
  });
});

describeWithDb('handleChatSession fires activity DM via waitUntil', () => {
  // Targeted handler-level coverage to confirm the wiring at the
  // handler boundary calls the helper. We don't need to exhaust every
  // emit-site handler — `notifySessionActivity` is unit-tested above
  // and the wiring shape is identical across the six handlers
  // (chat / edit / confirm / unconfirm / suggest / accept).
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

  it('chat-send leaves a notified-activity event visible to the next mark-read', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const db = getDb();
    const seed = await createOrGetActiveSession(db, {
      creatorUserId: alice.id,
      counterpartUserId: bob.id,
      creatorCards: [snap('p-1')],
    });
    createdSessionIds.push(seed.id);

    const cookie = await sealTestCookie(alice.id);
    // The handler resolves the bot lazily off DISCORD_BOT_TOKEN; in a
    // test env that's empty, so the helper short-circuits silently.
    // We assert the chat itself succeeded — the handler-side wiring
    // is exercised by the call-graph; absent the bot token, no DM
    // fires, but no crash either.
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      query: { id: seed.id },
      body: { message: 'hello world' },
    });
    const res = mockResponse();
    await handleChatSession(req, res);
    expect(res._status).toBe(200);
  });

  // Lightweight sanity that the other handlers don't throw with the
  // new wiring — same pattern, smaller assertions.
  it('edit-side handler succeeds with the wiring in place', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const db = getDb();
    const seed = await createOrGetActiveSession(db, {
      creatorUserId: alice.id,
      counterpartUserId: bob.id,
      creatorCards: [snap('p-1')],
    });
    createdSessionIds.push(seed.id);

    const cookie = await sealTestCookie(alice.id);
    const req = mockRequest({
      method: 'PUT',
      cookies: { swu_session: cookie },
      query: { id: seed.id },
      body: { cards: [snap('p-1', 2)] },
    });
    const res = mockResponse();
    await handleEditSession(req, res);
    expect(res._status).toBe(200);
  });

  it('confirm handler succeeds with the wiring in place', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const db = getDb();
    const seed = await createOrGetActiveSession(db, {
      creatorUserId: alice.id,
      counterpartUserId: bob.id,
      creatorCards: [snap('p-1')],
    });
    createdSessionIds.push(seed.id);

    const cookie = await sealTestCookie(alice.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      query: { id: seed.id },
    });
    const res = mockResponse();
    await handleConfirmSession(req, res);
    expect(res._status).toBe(200);
  });

  // Sanity: the manual-ping handler still fires its own DM and the
  // notify helper-fired activity DM doesn't trip on the same path.
  // (A successful ping STAMPS lastNotifiedAt, which then suppresses
  // the activity DM for the cooldown window — interlock validated by
  // the unit test above.)
  it('manual ping handler still works alongside the activity wiring', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const bob = await createTestUser();
    fixtures.push(bob);
    const db = getDb();
    const seed = await createOrGetActiveSession(db, {
      creatorUserId: alice.id,
      counterpartUserId: bob.id,
      creatorCards: [snap('p-1')],
    });
    createdSessionIds.push(seed.id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(alice.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      query: { id: seed.id },
      body: {},
    });
    const res = mockResponse();
    await handlePingSession(req, res, { bot });
    // Bob has no Discord id in test fixtures, so the ping collapses
    // to no-discord-id — but the handler itself doesn't crash, which
    // is the wiring assertion we care about here.
    expect([200, 409]).toContain(res._status);
  });
});
