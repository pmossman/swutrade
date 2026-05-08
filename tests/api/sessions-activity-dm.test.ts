import { describeWithDb, mockRequest, mockResponse, createTestUser, sealTestCookie } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleChatSession,
  handleEditSession,
  handleConfirmSession,
} from '../../api/sessions.js';
import { runSessionFollowupsSweep } from '../../api/bot.js';
import { getDb } from '../../lib/db.js';
import {
  sessionEvents,
  tradeSessions,
  users,
  type TradeCardSnapshot,
} from '../../lib/schema.js';
import {
  createOrGetActiveSession,
  recordSessionEvent,
  sendChatMessage,
} from '../../lib/sessions.js';
import type { DiscordBotClient } from '../../lib/discordBot.js';
import { createBaseFakeBot, type SendCall } from './discordFakes.js';

/**
 * Activity DM coverage. The flow used to fire synchronously from each
 * emit-site (`notifySessionActivity` with a 10-min cooldown); since
 * 2026-05-08 it's a periodic cron sweep
 * (`api/bot.ts::runSessionFollowupsSweep`, action `cron-session-
 * followups`, every 2 min). This file exercises the sweep against
 * a real DB:
 *
 *   - Happy path: counterpart-authored activity → DM, last_notified_at
 *     stamped, `notified` event with kind='activity' recorded.
 *   - Already DM'd: a re-sweep with no new counterpart activity is a
 *     no-op (idempotent).
 *   - Read-state gate: counterpart authored activity, then recipient
 *     marked-read past the activity → no DM (they've seen it).
 *   - Pref opt-out: dmSessionActivity=false → no DM.
 *   - Ghost recipient: no Discord id → no DM.
 *   - Terminal session: cancelled / settled / expired skipped.
 *   - Open-slot session: counterpart slot is null → skipped (no
 *     counterpart to author activity).
 *   - Self-authored events: don't notify yourself.
 *   - Activity event filter: edit-snapshot and notified events don't
 *     count as activity (excluded from the sweep's input set).
 *
 * The handler-level smoke tests at the bottom are kept from the
 * pre-cron iteration — they just confirm chat/edit/confirm handlers
 * still succeed end-to-end after the sync DM call sites were
 * removed.
 */

function snap(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1 };
}

function makeFakeBot(): DiscordBotClient & { sendCalls: SendCall[] } {
  const sendCalls: SendCall[] = [];
  return Object.assign(
    createBaseFakeBot({
      async createDmChannel() { return { id: 'dm-fake' }; },
      async sendDirectMessage(userId, body) {
        sendCalls.push({ userId, body });
        return { id: 'msg-activity', channel_id: 'dm-fake' };
      },
    }),
    { sendCalls },
  );
}

/**
 * Run the cron sweep with a fake bot + scoped to specific sessions.
 * The CI test DB accumulates thousands of leftover active sessions
 * across runs; without `sessionIds` scoping the sweep iterates them
 * all and hits the vitest timeout. Production calls omit the scope
 * (sweep walks all active sessions).
 */
async function runSweep(bot: DiscordBotClient, sessionIds: string[]): Promise<{
  scanned: number;
  dmd: number;
  skipped: number;
  errors: number;
}> {
  const req = mockRequest({ method: 'GET' });
  const res = mockResponse();
  await runSessionFollowupsSweep(req, res, {
    bot,
    appBaseUrl: 'https://beta.swutrade.com',
    sessionIds,
  });
  expect(res._status).toBe(200);
  return res._json as { scanned: number; dmd: number; skipped: number; errors: number };
}

describeWithDb('cron-session-followups sweep', () => {
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

  it('happy path: counterpart-authored activity → DM, last_notified_at stamped, notified event recorded', async () => {
    const { alice, bob, sessionId } = await seedPair();
    const db = getDb();

    // Alice (counterpart of Bob) chats. The chat send already
    // records its own `chat` session_event.
    await sendChatMessage(db, {
      sessionId,
      viewerUserId: alice.id,
      body: 'hello',
    });
    const bot = makeFakeBot();
    const stats = await runSweep(bot, [sessionId]);
    expect(stats.dmd).toBe(1);
    // Bob has a real Discord id (createTestUser sets one), so a DM
    // goes out.
    expect(bot.sendCalls).toHaveLength(1);

    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, sessionId)).limit(1);
    expect(row?.lastNotifiedAt[bob.id]).toBeTruthy();

    const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
    const notifiedEvents = events.filter(
      e => e.type === 'notified' && (e.payload as { kind?: string } | null)?.kind === 'activity',
    );
    expect(notifiedEvents).toHaveLength(1);
  });

  it('idempotent re-sweep: a second run with no new counterpart activity is a no-op', async () => {
    const { alice, sessionId } = await seedPair();
    const db = getDb();
    await sendChatMessage(db, { sessionId, viewerUserId: alice.id, body: 'hi' });

    const bot1 = makeFakeBot();
    const stats1 = await runSweep(bot1, [sessionId]);
    expect(stats1.dmd).toBe(1);

    const bot2 = makeFakeBot();
    const stats2 = await runSweep(bot2, [sessionId]);
    expect(stats2.dmd).toBe(0);
    expect(bot2.sendCalls).toHaveLength(0);
  });

  it('read-state gate: recipient mark-read past the activity → no DM', async () => {
    const { alice, bob, sessionId } = await seedPair();
    const db = getDb();
    await sendChatMessage(db, { sessionId, viewerUserId: alice.id, body: 'hi' });

    // Bob marks-read AFTER Alice's chat. createOrGetActiveSession
    // enforces canonical user_a_id < user_b_id ordering so we don't
    // know which slot Bob landed in — look it up.
    const [row] = await db
      .select({ userAId: tradeSessions.userAId, userBId: tradeSessions.userBId })
      .from(tradeSessions)
      .where(eq(tradeSessions.id, sessionId))
      .limit(1);
    const bobIsUserA = row.userAId === bob.id;
    await db
      .update(tradeSessions)
      .set(bobIsUserA ? { userALastReadAt: new Date() } : { userBLastReadAt: new Date() })
      .where(eq(tradeSessions.id, sessionId));

    const bot = makeFakeBot();
    const stats = await runSweep(bot, [sessionId]);
    expect(stats.dmd).toBe(0);
    expect(stats.skipped).toBeGreaterThan(0);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('pref opt-out: dmSessionActivity=false → no DM', async () => {
    const { alice, bob, sessionId } = await seedPair();
    const db = getDb();
    await db.update(users).set({ dmSessionActivity: false }).where(eq(users.id, bob.id));
    await sendChatMessage(db, { sessionId, viewerUserId: alice.id, body: 'hi' });

    const bot = makeFakeBot();
    const stats = await runSweep(bot, [sessionId]);
    expect(stats.dmd).toBe(0);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('ghost recipient: no Discord id → no DM', async () => {
    const { alice, bob, sessionId } = await seedPair();
    const db = getDb();
    await db.update(users).set({ discordId: null }).where(eq(users.id, bob.id));
    await sendChatMessage(db, { sessionId, viewerUserId: alice.id, body: 'hi' });

    const bot = makeFakeBot();
    const stats = await runSweep(bot, [sessionId]);
    expect(stats.dmd).toBe(0);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('terminal session: cancelled session is skipped entirely', async () => {
    const { alice, sessionId } = await seedPair();
    const db = getDb();
    await sendChatMessage(db, { sessionId, viewerUserId: alice.id, body: 'hi' });
    await db.update(tradeSessions).set({ status: 'cancelled' }).where(eq(tradeSessions.id, sessionId));

    const bot = makeFakeBot();
    const stats = await runSweep(bot, [sessionId]);
    expect(stats.dmd).toBe(0);
    expect(bot.sendCalls).toHaveLength(0);
    // Cancelled session isn't even scanned — only `status = active`
    // rows enter the loop.
  });

  it('self-authored activity (no counterpart slot filled) does not DM the actor', async () => {
    // This is implicit in the cron's per-recipient loop: the actor
    // is excluded from "counterpart authored activity" lookups by
    // construction. Cover it explicitly: Bob authors, only Alice
    // gets DM'd, never Bob.
    const { alice, bob, sessionId } = await seedPair();
    const db = getDb();
    await sendChatMessage(db, { sessionId, viewerUserId: bob.id, body: 'from bob' });

    const bot = makeFakeBot();
    const stats = await runSweep(bot, [sessionId]);
    expect(stats.dmd).toBe(1);
    expect(bot.sendCalls).toHaveLength(1);

    const [row] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, sessionId)).limit(1);
    expect(row?.lastNotifiedAt[alice.id]).toBeTruthy();
    expect(row?.lastNotifiedAt[bob.id]).toBeUndefined();
  });

  it('activity-event filter: only chat/edited/confirmed/suggestion-* count; edit-snapshot and notified do not', async () => {
    const { alice, sessionId } = await seedPair();
    const db = getDb();
    // Record an edit-snapshot event (internal bookkeeping). It must
    // NOT trigger a DM because edit-snapshot is excluded from
    // ACTIVITY_EVENT_TYPES.
    await recordSessionEvent(db, {
      sessionId,
      actorUserId: alice.id,
      type: 'edit-snapshot',
      payload: { yourCards: [], theirCards: [] },
    });

    const bot = makeFakeBot();
    const stats = await runSweep(bot, [sessionId]);
    expect(stats.dmd).toBe(0);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('multi-session sweep: handles N sessions in one run', async () => {
    const pair1 = await seedPair();
    const pair2 = await seedPair();
    const db = getDb();
    await sendChatMessage(db, { sessionId: pair1.sessionId, viewerUserId: pair1.alice.id, body: 'one' });
    await sendChatMessage(db, { sessionId: pair2.sessionId, viewerUserId: pair2.alice.id, body: 'two' });

    const bot = makeFakeBot();
    const stats = await runSweep(bot, [pair1.sessionId, pair2.sessionId]);
    expect(stats.dmd).toBe(2);
    expect(bot.sendCalls).toHaveLength(2);
  });

  it('open-slot session is scanned but skipped (no counterpart to author activity)', async () => {
    const alice = await createTestUser();
    fixtures.push(alice);
    const db = getDb();
    // Open-slot session: no userBId.
    const openId = `open-${Math.random().toString(36).slice(2, 10)}`;
    createdSessionIds.push(openId);
    await db.insert(tradeSessions).values({
      id: openId,
      userAId: alice.id,
      userBId: null,
      userACards: [snap('p-1')],
      userBCards: [],
      confirmedByUserIds: [],
      lastEditedAt: new Date(),
      lastEditedByUserId: null,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      status: 'active',
      lastNotifiedAt: {},
      pendingSuggestions: [],
    });

    const bot = makeFakeBot();
    const stats = await runSweep(bot, [openId]);
    // Scanned ≥ 1, dmd = 0 (no userBId means no counterpart loop).
    expect(stats.scanned).toBeGreaterThanOrEqual(1);
    expect(stats.dmd).toBe(0);
    expect(bot.sendCalls).toHaveLength(0);
  });
});

describeWithDb('handlers post-cron-refactor (no sync DM call)', () => {
  // After the 2026-05-08 refactor, chat / edit / confirm / unconfirm /
  // suggest / accept-suggestion handlers no longer fire DMs synchronously
  // — the cron sweep above owns that. These tests just confirm the
  // handlers still complete successfully end-to-end after the call
  // sites were removed.
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

  it('chat-send handler still succeeds with no sync DM call', async () => {
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
      body: { message: 'hello world' },
    });
    const res = mockResponse();
    await handleChatSession(req, res);
    expect(res._status).toBe(200);
  });

  it('edit-side handler still succeeds with no sync DM call', async () => {
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

  it('confirm handler still succeeds with no sync DM call', async () => {
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
});
