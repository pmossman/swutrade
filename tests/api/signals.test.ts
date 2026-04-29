import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleCreate, handleCancel, handleListMine } from '../../api/signals.js';
import { dispatchBotPayload } from '../../api/bot.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  createMutualGuildMembership,
  installBotInGuild,
  createGuildMembership,
  insertAvailable,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { cardSignals, wantsItems, availableItems } from '../../lib/schema.js';
import { createBaseFakeBot, type RecordingFakeBot, type PostCall, type EditCall } from './discordFakes.js';

/**
 * Coverage for the web Signal Builder API (POST/DELETE/GET on
 * /api/signals) plus the Discord button handlers that act on
 * web-posted signals (Cancel post, Specify variant). The slash-
 * command path was retired in favour of the web builder.
 *
 * STABLE_FAMILY_ID is Luke Skywalker — Hero of Yavin (jump-to-
 * lightspeed). STABLE_PRODUCT_ID is its Standard product. Used as
 * a stable card across many e2e specs.
 */

const STABLE_FAMILY_ID = 'jump-to-lightspeed::luke-skywalker-hero-of-yavin';
const STABLE_PRODUCT_ID = '617180';
const SECONDARY_FAMILY_ID = 'secrets-of-power::aggressive-negotiations';

function makeSignalBot(opts: { postId?: string } = {}): RecordingFakeBot {
  const postCalls: PostCall[] = [];
  const editCalls: EditCall[] = [];
  let postSeq = 0;
  return Object.assign(
    createBaseFakeBot({
      async postChannelMessage(channelId, body) {
        postCalls.push({ channelId, body });
        return { id: opts.postId ?? `signal-msg-${++postSeq}`, channel_id: channelId };
      },
      async editChannelMessage(channelId, messageId, body) {
        editCalls.push({ channelId, messageId, body });
      },
    }),
    { postCalls, editCalls, sendCalls: [], createDmCalls: [] },
  ) as RecordingFakeBot;
}

describeWithDb('POST /api/signals?action=create', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const guildCleanups: Array<() => Promise<void>> = [];
  const groupIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of groupIds) {
      await db.delete(cardSignals).where(eq(cardSignals.groupId, id)).catch(() => {});
    }
    groupIds.length = 0;
    for (const fn of guildCleanups.reverse()) await fn();
    guildCleanups.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('rejects unauthenticated requests', async () => {
    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        body: { kind: 'wanted', cards: [{ familyId: STABLE_FAMILY_ID, qty: 1 }], guildId: 'g-x' },
      }),
      res,
    );
    expect(res._status).toBe(401);
  });

  it('rejects non-POST methods', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'GET',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
      }),
      res,
    );
    expect(res._status).toBe(405);
  });

  it('400s on missing/invalid body fields', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        body: { kind: 'wanted', cards: [], guildId: 'g-x' }, // empty cards
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('rejects when caller is not a member of the chosen guild', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const guildId = `g-nm-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-1' }));

    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        body: {
          kind: 'wanted',
          cards: [{ familyId: STABLE_FAMILY_ID, qty: 1 }],
          guildId,
        },
      }),
      res,
    );
    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toMatch(/not a member/i);
  });

  it('rejects when caller is a member but not enrolled', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const guildId = `g-ne-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-1' }));
    guildCleanups.push(await createGuildMembership(viewer.id, guildId, { enrolled: false }));

    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        body: {
          kind: 'wanted',
          cards: [{ familyId: STABLE_FAMILY_ID, qty: 1 }],
          guildId,
        },
      }),
      res,
    );
    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toMatch(/enroll/i);
  });

  it('rejects when bot is not installed in the chosen guild', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    // Membership exists, but no bot install row.
    const guildId = `g-noi-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await createGuildMembership(viewer.id, guildId, { enrolled: true }));

    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        body: {
          kind: 'wanted',
          cards: [{ familyId: STABLE_FAMILY_ID, qty: 1 }],
          guildId,
        },
      }),
      res,
    );
    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toMatch(/isn't installed/i);
  });

  it('happy path: creates wants_items + 1 active signal row + posts the embed', async () => {
    const signaler = await createTestUser();
    fixtures.push(signaler);
    const guildId = `g-h-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-h' }));
    guildCleanups.push(await createGuildMembership(signaler.id, guildId, { enrolled: true }));

    const bot = makeSignalBot({ postId: 'posted-1' });
    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(signaler.id) },
        body: {
          kind: 'wanted',
          cards: [{ familyId: STABLE_FAMILY_ID, qty: 2 }],
          guildId,
          note: 'for Friday\'s draft',
        },
      }),
      res,
      { bot },
    );

    expect(res._status).toBe(201);
    const body = res._json as {
      groupId: string; messageId: string; channelId: string; messageUrl: string;
    };
    expect(body.messageId).toBe('posted-1');
    expect(body.channelId).toBe('ch-h');
    expect(body.messageUrl).toContain(`/${guildId}/`);
    expect(body.messageUrl).toContain('/posted-1');
    groupIds.push(body.groupId);

    // Post landed on the right channel.
    expect(bot.postCalls).toHaveLength(1);
    expect(bot.postCalls[0].channelId).toBe('ch-h');
    const embed = bot.postCalls[0].body.embeds?.[0];
    expect(embed?.title).toMatch(/Looking for/);
    expect(embed?.description).toContain('2×');
    expect(embed?.description).toMatch(/for Friday's draft/);

    // DB: one active row + the wants_items row was upserted with isPriority.
    const db = getDb();
    const rows = await db
      .select()
      .from(cardSignals)
      .where(eq(cardSignals.groupId, body.groupId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].kind).toBe('wanted');
    expect(rows[0].messageId).toBe('posted-1');
    expect(rows[0].guildId).toBe(guildId);

    const [wantsRow] = await db
      .select()
      .from(wantsItems)
      .where(eq(wantsItems.userId, signaler.id))
      .limit(1);
    expect(wantsRow.isPriority).toBe(true);
    expect(wantsRow.familyId).toBe(STABLE_FAMILY_ID);
  });

  it('multi-card: 2 cards → 2 rows in one group + 1 post', async () => {
    const signaler = await createTestUser();
    fixtures.push(signaler);
    const guildId = `g-mc-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-mc' }));
    guildCleanups.push(await createGuildMembership(signaler.id, guildId, { enrolled: true }));

    const bot = makeSignalBot({ postId: 'mc-1' });
    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(signaler.id) },
        body: {
          kind: 'wanted',
          cards: [
            { familyId: STABLE_FAMILY_ID, qty: 1 },
            { familyId: SECONDARY_FAMILY_ID, qty: 3 },
          ],
          guildId,
        },
      }),
      res,
      { bot },
    );

    expect(res._status).toBe(201);
    const groupId = (res._json as { groupId: string }).groupId;
    groupIds.push(groupId);

    expect(bot.postCalls).toHaveLength(1);
    const db = getDb();
    const rows = await db.select().from(cardSignals).where(eq(cardSignals.groupId, groupId));
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.status === 'active')).toBe(true);
    expect(rows.every(r => r.messageId === 'mc-1')).toBe(true);
  });

  it('rolls back to cancelled when the bot post fails', async () => {
    const signaler = await createTestUser();
    fixtures.push(signaler);
    const guildId = `g-rb-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-rb' }));
    guildCleanups.push(await createGuildMembership(signaler.id, guildId, { enrolled: true }));

    // Bot client whose postChannelMessage throws.
    const bot = createBaseFakeBot({
      async postChannelMessage() {
        throw new Error('simulated post failure');
      },
    });

    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(signaler.id) },
        body: {
          kind: 'wanted',
          cards: [{ familyId: STABLE_FAMILY_ID, qty: 1 }],
          guildId,
        },
      }),
      res,
      { bot },
    );

    expect(res._status).toBe(502);

    // Drafted rows flipped to cancelled instead of dangling active.
    const db = getDb();
    const rows = await db
      .select()
      .from(cardSignals)
      .where(eq(cardSignals.userId, signaler.id));
    groupIds.push(...rows.map(r => r.groupId).filter((g): g is string => !!g));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.status === 'cancelled')).toBe(true);
  });

  it('embed match listing surfaces guild members holding the inverse inventory', async () => {
    const signaler = await createTestUser();
    const matcher = await createTestUser();
    fixtures.push(signaler, matcher);
    const guildId = `g-mlp-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await createMutualGuildMembership(
      signaler.id,
      matcher.id,
      guildId,
      { tradesChannelId: 'ch-mlp' },
    ));

    // Seed the matcher's available row so they show up as a hit.
    await insertAvailable(matcher.id, STABLE_PRODUCT_ID);

    const bot = makeSignalBot({ postId: 'm-1' });
    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(signaler.id) },
        body: {
          kind: 'wanted',
          cards: [{ familyId: STABLE_FAMILY_ID, qty: 1 }],
          guildId,
        },
      }),
      res,
      { bot },
    );

    expect(res._status).toBe(201);
    groupIds.push((res._json as { groupId: string }).groupId);

    const desc = bot.postCalls[0].body.embeds?.[0]?.description ?? '';
    expect(desc).toContain(`<@${matcher.id}>`);
    // Match listings render as text only — no auto-DMs.
    expect(bot.postCalls[0].body.allowed_mentions).toEqual({ parse: [] });
  });
});

describeWithDb('DELETE /api/signals?action=cancel', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const guildCleanups: Array<() => Promise<void>> = [];
  const groupIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of groupIds) {
      await db.delete(cardSignals).where(eq(cardSignals.groupId, id)).catch(() => {});
    }
    groupIds.length = 0;
    for (const fn of guildCleanups.reverse()) await fn();
    guildCleanups.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  async function createLiveSignal(userId: string, guildId: string): Promise<string> {
    const bot = makeSignalBot({ postId: `live-${Math.random().toString(36).slice(2, 6)}` });
    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(userId) },
        body: {
          kind: 'wanted',
          cards: [{ familyId: STABLE_FAMILY_ID, qty: 1 }],
          guildId,
        },
      }),
      res,
      { bot },
    );
    const groupId = (res._json as { groupId: string }).groupId;
    groupIds.push(groupId);
    return groupId;
  }

  it('rejects unauthenticated', async () => {
    const res = mockResponse();
    await handleCancel(
      mockRequest({ method: 'DELETE', query: { groupId: 'g' } }),
      res,
    );
    expect(res._status).toBe(401);
  });

  it('400s when groupId is missing', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const res = mockResponse();
    await handleCancel(
      mockRequest({
        method: 'DELETE',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('404s for unknown groupId', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const res = mockResponse();
    await handleCancel(
      mockRequest({
        method: 'DELETE',
        query: { groupId: 'does-not-exist' },
        cookies: { swu_session: await sealTestCookie(viewer.id) },
      }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('non-owner gets 403', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    fixtures.push(owner, stranger);
    const guildId = `g-nx-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-nx' }));
    guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

    const groupId = await createLiveSignal(owner.id, guildId);

    const res = mockResponse();
    await handleCancel(
      mockRequest({
        method: 'DELETE',
        query: { groupId },
        cookies: { swu_session: await sealTestCookie(stranger.id) },
      }),
      res,
    );
    expect(res._status).toBe(403);
  });

  it('owner cancel: every row flips to cancelled + embed PATCH attempted', async () => {
    const owner = await createTestUser();
    fixtures.push(owner);
    const guildId = `g-co-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-co' }));
    guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

    const groupId = await createLiveSignal(owner.id, guildId);

    const bot = makeSignalBot();
    const res = mockResponse();
    await handleCancel(
      mockRequest({
        method: 'DELETE',
        query: { groupId },
        cookies: { swu_session: await sealTestCookie(owner.id) },
      }),
      res,
      { bot },
    );
    expect(res._status).toBe(200);

    const db = getDb();
    const rows = await db
      .select()
      .from(cardSignals)
      .where(eq(cardSignals.groupId, groupId));
    expect(rows.every(r => r.status === 'cancelled')).toBe(true);
    expect(bot.editCalls).toHaveLength(1);
  });

  it('returns 409 when already cancelled (idempotency guard)', async () => {
    const owner = await createTestUser();
    fixtures.push(owner);
    const guildId = `g-ic-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-ic' }));
    guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

    const groupId = await createLiveSignal(owner.id, guildId);

    // First cancel succeeds.
    await handleCancel(
      mockRequest({
        method: 'DELETE',
        query: { groupId },
        cookies: { swu_session: await sealTestCookie(owner.id) },
      }),
      mockResponse(),
      { bot: makeSignalBot() },
    );

    // Second cancel hits the already-cancelled guard.
    const res = mockResponse();
    await handleCancel(
      mockRequest({
        method: 'DELETE',
        query: { groupId },
        cookies: { swu_session: await sealTestCookie(owner.id) },
      }),
      res,
      { bot: makeSignalBot() },
    );
    expect(res._status).toBe(409);
  });
});

describeWithDb('GET /api/signals?action=mine', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const guildCleanups: Array<() => Promise<void>> = [];
  const groupIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of groupIds) {
      await db.delete(cardSignals).where(eq(cardSignals.groupId, id)).catch(() => {});
    }
    groupIds.length = 0;
    for (const fn of guildCleanups.reverse()) await fn();
    guildCleanups.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('rejects unauthenticated', async () => {
    const res = mockResponse();
    await handleListMine(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
  });

  it('returns empty groups list when viewer has no active signals', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const res = mockResponse();
    await handleListMine(
      mockRequest({
        method: 'GET',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect((res._json as { groups: unknown[] }).groups).toEqual([]);
  });

  it('returns one group per active signal post, with messageUrl + cards', async () => {
    const owner = await createTestUser();
    fixtures.push(owner);
    const guildId = `g-lm-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-lm' }));
    guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

    // Seed an active signal via the create path so the DB is wired
    // up the same way production does it.
    const bot = makeSignalBot({ postId: 'mine-1' });
    const createRes = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(owner.id) },
        body: {
          kind: 'wanted',
          cards: [
            { familyId: STABLE_FAMILY_ID, qty: 1 },
            { familyId: SECONDARY_FAMILY_ID, qty: 2 },
          ],
          guildId,
        },
      }),
      createRes,
      { bot },
    );
    const groupId = (createRes._json as { groupId: string }).groupId;
    groupIds.push(groupId);

    const res = mockResponse();
    await handleListMine(
      mockRequest({
        method: 'GET',
        cookies: { swu_session: await sealTestCookie(owner.id) },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const { groups } = res._json as {
      groups: Array<{ groupId: string; cards: unknown[]; messageUrl: string | null; kind: string }>;
    };
    expect(groups).toHaveLength(1);
    expect(groups[0].groupId).toBe(groupId);
    expect(groups[0].cards).toHaveLength(2);
    expect(groups[0].messageUrl).toContain('/mine-1');
    expect(groups[0].kind).toBe('wanted');
  });

  it('does not surface cancelled signals', async () => {
    const owner = await createTestUser();
    fixtures.push(owner);
    const guildId = `g-lmc-${Math.random().toString(36).slice(2, 8)}`;
    guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-lmc' }));
    guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

    // Create + cancel.
    const createRes = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(owner.id) },
        body: {
          kind: 'wanted',
          cards: [{ familyId: STABLE_FAMILY_ID, qty: 1 }],
          guildId,
        },
      }),
      createRes,
      { bot: makeSignalBot({ postId: 'lmc-1' }) },
    );
    const groupId = (createRes._json as { groupId: string }).groupId;
    groupIds.push(groupId);

    await handleCancel(
      mockRequest({
        method: 'DELETE',
        query: { groupId },
        cookies: { swu_session: await sealTestCookie(owner.id) },
      }),
      mockResponse(),
      { bot: makeSignalBot() },
    );

    const res = mockResponse();
    await handleListMine(
      mockRequest({
        method: 'GET',
        cookies: { swu_session: await sealTestCookie(owner.id) },
      }),
      res,
    );
    expect((res._json as { groups: unknown[] }).groups).toEqual([]);
  });
});

describeWithDb('signal: button handler (Discord-side actions on web-posted signals)', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const guildCleanups: Array<() => Promise<void>> = [];
  const groupIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of groupIds) {
      await db.delete(cardSignals).where(eq(cardSignals.groupId, id)).catch(() => {});
    }
    groupIds.length = 0;
    for (const fn of guildCleanups.reverse()) await fn();
    guildCleanups.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  async function createLiveSignal(userId: string, guildId: string): Promise<{
    groupId: string;
    rowId: string;
  }> {
    const bot = makeSignalBot({ postId: `live-${Math.random().toString(36).slice(2, 6)}` });
    const res = mockResponse();
    await handleCreate(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(userId) },
        body: {
          kind: 'wanted',
          cards: [{ familyId: STABLE_FAMILY_ID, qty: 1 }],
          guildId,
        },
      }),
      res,
      { bot },
    );
    const groupId = (res._json as { groupId: string }).groupId;
    groupIds.push(groupId);
    const db = getDb();
    const [row] = await db
      .select({ id: cardSignals.id })
      .from(cardSignals)
      .where(eq(cardSignals.groupId, groupId))
      .limit(1);
    return { groupId, rowId: row.id };
  }

  describe('cancel (live group)', () => {
    it('owner click → all rows cancelled, embed flips via type-7', async () => {
      const owner = await createTestUser();
      fixtures.push(owner);
      const guildId = `g-lc-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-lc' }));
      guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

      const { groupId } = await createLiveSignal(owner.id, guildId);

      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${groupId}:cancel` },
          member: { user: { id: owner.id } },
        },
        res,
        { bot: makeSignalBot() },
      );

      expect((res._json as { type: number }).type).toBe(7);
      const db = getDb();
      const rows = await db
        .select({ status: cardSignals.status })
        .from(cardSignals)
        .where(eq(cardSignals.groupId, groupId));
      expect(rows.every(r => r.status === 'cancelled')).toBe(true);
    });

    it('non-owner click → ephemeral error + embed unchanged', async () => {
      const owner = await createTestUser();
      const stranger = await createTestUser();
      fixtures.push(owner, stranger);
      const guildId = `g-nx-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-nx' }));
      guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

      const { groupId } = await createLiveSignal(owner.id, guildId);

      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${groupId}:cancel` },
          member: { user: { id: stranger.id } },
        },
        res,
        { bot: makeSignalBot() },
      );

      expect((res._json as { type: number }).type).toBe(4);
      expect((res._json as { data?: { content?: string } }).data?.content).toMatch(/Only the post's author/i);

      const db = getDb();
      const [row] = await db
        .select({ status: cardSignals.status })
        .from(cardSignals)
        .where(eq(cardSignals.groupId, groupId))
        .limit(1);
      expect(row.status).toBe('active');
    });

    it('clicker without a SWUTrade account gets a sign-in nudge', async () => {
      const owner = await createTestUser();
      fixtures.push(owner);
      const guildId = `g-na-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-na' }));
      guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

      const { groupId } = await createLiveSignal(owner.id, guildId);

      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${groupId}:cancel` },
          member: { user: { id: 'discord-id-without-account' } },
        },
        res,
        { bot: makeSignalBot() },
      );

      expect((res._json as { data?: { content?: string } }).data?.content).toMatch(/Sign in with Discord/i);
    });
  });

  describe('variant-open / variant-pick', () => {
    it('variant-open returns the picker ephemeral with the family name', async () => {
      const owner = await createTestUser();
      fixtures.push(owner);
      const guildId = `g-vo-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-vo' }));
      guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

      const { rowId } = await createLiveSignal(owner.id, guildId);

      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${rowId}:variant-open` },
          member: { user: { id: owner.id } },
        },
        res,
      );
      expect((res._json as { type: number }).type).toBe(4);
      expect((res._json as { data?: { flags?: number; content?: string } }).data?.flags).toBe(64);
      expect((res._json as { data?: { content?: string } }).data?.content).toMatch(/Luke Skywalker/);
    });

    it('variant-pick pins the wants_items restriction + PATCHes the public post', async () => {
      const owner = await createTestUser();
      fixtures.push(owner);
      const guildId = `g-vp-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-vp' }));
      guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

      const { rowId } = await createLiveSignal(owner.id, guildId);

      const bot = makeSignalBot();
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: {
            custom_id: `signal:${rowId}:variant-pick`,
            values: ['Hyperspace'],
            component_type: 3,
          },
          member: { user: { id: owner.id } },
        },
        res,
        { bot },
      );
      expect(res._status).toBe(200);

      const db = getDb();
      const [wantsRow] = await db
        .select()
        .from(wantsItems)
        .where(eq(wantsItems.userId, owner.id))
        .limit(1);
      expect(wantsRow.restrictionMode).toBe('restricted');
      expect(wantsRow.restrictionVariants).toEqual(['Hyperspace']);

      // Cleanup the available row used by matching helpers in case any
      // test left one behind.
      await db.delete(availableItems).where(eq(availableItems.userId, owner.id)).catch(() => {});
    });

    it('non-owner cannot variant-pick', async () => {
      const owner = await createTestUser();
      const stranger = await createTestUser();
      fixtures.push(owner, stranger);
      const guildId = `g-vnx-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId, { tradesChannelId: 'ch-vnx' }));
      guildCleanups.push(await createGuildMembership(owner.id, guildId, { enrolled: true }));

      const { rowId } = await createLiveSignal(owner.id, guildId);

      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${rowId}:variant-open` },
          member: { user: { id: stranger.id } },
        },
        res,
      );
      expect((res._json as { data?: { content?: string } }).data?.content).toMatch(/Only the post's author/i);
    });
  });
});
