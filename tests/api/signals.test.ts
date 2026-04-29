import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { dispatchBotPayload } from '../../api/bot.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  createMutualGuildMembership,
  installBotInGuild,
  createGuildMembership,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import {
  cardSignals,
  wantsItems,
  availableItems,
  users,
} from '../../lib/schema.js';
import { createBaseFakeBot, type RecordingFakeBot, type PostCall, type SendCall, type EditCall } from './discordFakes.js';

/**
 * Integration coverage for `/looking-for` + `/offering` slash
 * commands and the `signal:cancel` button. Drives the deferred-
 * followup pattern: dispatch → synchronous type-5 ack → followup
 * does the side effects + PATCHes the @original message via the
 * captured fetchImpl.
 *
 * The slash `card:` option takes a family id (autocomplete returns
 * families). `STABLE_FAMILY_ID` is Luke Skywalker - Hero of Yavin,
 * stable across many e2e specs. `STABLE_PRODUCT_ID` is its Standard
 * printing — used for seeding available_items when we want the
 * matcher to fire.
 */

const STABLE_FAMILY_ID = 'jump-to-lightspeed::luke-skywalker-hero-of-yavin';
const STABLE_PRODUCT_ID = '617180';

interface FollowupCall {
  url: string;
  body: Record<string, unknown>;
}

function captureFollowup() {
  const calls: FollowupCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : (input as URL).toString(),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return Promise.resolve(new Response('', { status: 200 }));
  };
  return { calls, fetchImpl };
}

function makeSignalBot(opts: { postId?: string } = {}): RecordingFakeBot {
  const postCalls: PostCall[] = [];
  const sendCalls: SendCall[] = [];
  const editCalls: EditCall[] = [];
  const createDmCalls: string[] = [];
  let postSeq = 0;
  return Object.assign(
    createBaseFakeBot({
      async postChannelMessage(channelId, body) {
        postCalls.push({ channelId, body });
        return { id: opts.postId ?? `signal-msg-${++postSeq}`, channel_id: channelId };
      },
      async sendDirectMessage(userId, body) {
        sendCalls.push({ userId, body });
        return { id: `dm-${userId}`, channel_id: `dm-ch-${userId}` };
      },
      async createDmChannel(userId) {
        createDmCalls.push(userId);
        return { id: `dm-ch-${userId}` };
      },
      async editChannelMessage(channelId, messageId, body) {
        editCalls.push({ channelId, messageId, body });
      },
    }),
    { postCalls, sendCalls, editCalls, createDmCalls },
  ) as RecordingFakeBot;
}

function buildSignalPayload(opts: {
  command: 'looking-for' | 'offering';
  guildId: string;
  channelId: string;
  clickerDiscordId: string;
  /** Family id for the slash `card:` arg. */
  familyId: string;
  /** Optional pinned variant. When omitted, signal defaults to "any". */
  variant?: string;
  qty?: number;
  note?: string;
  maxPrice?: number;
}) {
  const options: Array<{ name: string; type: number; value: unknown }> = [
    { name: 'card', type: 3, value: opts.familyId },
  ];
  if (opts.variant != null) options.push({ name: 'variant', type: 3, value: opts.variant });
  if (opts.qty != null) options.push({ name: 'qty', type: 4, value: opts.qty });
  if (opts.note != null) options.push({ name: 'note', type: 3, value: opts.note });
  if (opts.maxPrice != null) options.push({ name: 'max_price', type: 10, value: opts.maxPrice });
  return {
    type: 2, // APPLICATION_COMMAND
    application_id: 'app-test',
    token: 'tok-test',
    guild_id: opts.guildId,
    channel_id: opts.channelId,
    member: { user: { id: opts.clickerDiscordId } },
    data: {
      type: 1, // CHAT_INPUT
      name: opts.command,
      options,
    },
  };
}

describeWithDb('signals: /looking-for + /offering slash + cancel + cron', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const guildCleanups: Array<() => Promise<void>> = [];
  const signalIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of signalIds) {
      await db.delete(cardSignals).where(eq(cardSignals.id, id)).catch(() => {});
    }
    signalIds.length = 0;
    for (const fn of guildCleanups.reverse()) await fn();
    guildCleanups.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  describe('/looking-for — slash submission', () => {
    it('happy path: inserts wants_items + card_signals, posts embed, returns "Posted!" ephemeral', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      // Map the synthetic users.id ↔ users.discord_id is the same in
      // createTestUser; the slash needs the signaler's discord_id to
      // resolve back to their SWUTrade user row.
      const guildId = `g-sig-${Math.random().toString(36).slice(2, 8)}`;
      const channelId = `ch-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const bot = makeSignalBot();
      const { calls, fetchImpl } = captureFollowup();
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId,
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
          qty: 2,
          note: 'for Friday\'s draft',
        }),
        res,
        { bot, fetchImpl, awaitFollowup: true },
      );

      // Synchronous response is the deferred ack.
      expect(res._status).toBe(200);
      expect((res._json as { type: number }).type).toBe(5);

      // Bot posted the public embed in the channel.
      expect(bot.postCalls).toHaveLength(1);
      expect(bot.postCalls[0].channelId).toBe(channelId);
      const embed = bot.postCalls[0].body.embeds?.[0];
      expect(embed?.title).toMatch(/Looking for/);

      // wants_items row created for the signaler.
      const db = getDb();
      const [wantsRow] = await db
        .select()
        .from(wantsItems)
        .where(eq(wantsItems.userId, signaler.id))
        .limit(1);
      expect(wantsRow).toBeTruthy();
      expect(wantsRow.qty).toBe(2);

      // card_signals row created.
      const [signalRow] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.userId, signaler.id))
        .limit(1);
      expect(signalRow).toBeTruthy();
      expect(signalRow.kind).toBe('wanted');
      expect(signalRow.guildId).toBe(guildId);
      expect(signalRow.channelId).toBe(channelId);
      expect(signalRow.signalNote).toBe('for Friday\'s draft');
      expect(signalRow.status).toBe('active');
      signalIds.push(signalRow.id);

      // Followup ack body confirms post.
      expect(calls).toHaveLength(1);
      expect((calls[0].body as { content?: string }).content).toMatch(/Posted/);
    });

    it('rejects when called outside a guild (DMs)', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const bot = makeSignalBot();
      const { calls, fetchImpl } = captureFollowup();
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 2,
          application_id: 'app-test',
          token: 'tok-test',
          // no guild_id → DM context
          channel_id: 'ch-dm',
          user: { id: signaler.id },
          data: { type: 1, name: 'looking-for', options: [{ name: 'card', type: 3, value: STABLE_PRODUCT_ID }] },
        },
        res,
        { bot, fetchImpl, awaitFollowup: true },
      );
      expect(calls).toHaveLength(1);
      expect((calls[0].body as { content?: string }).content).toMatch(/only work inside a server/i);
      expect(bot.postCalls).toHaveLength(0);
    });

    it('rejects when bot is not installed in the guild', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const bot = makeSignalBot();
      const { calls, fetchImpl } = captureFollowup();
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId: 'g-uninstalled',
          channelId: 'ch-1',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        res,
        { bot, fetchImpl, awaitFollowup: true },
      );
      expect((calls[0].body as { content?: string }).content).toMatch(/SWUTrade isn't installed/i);
      expect(bot.postCalls).toHaveLength(0);
    });

    it('rejects when slash author isn\'t a SWUTrade user', async () => {
      const guildId = `g-noauth-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      const bot = makeSignalBot();
      const { calls, fetchImpl } = captureFollowup();
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-1',
          clickerDiscordId: 'discord-id-without-swutrade-account',
          familyId: STABLE_FAMILY_ID,
        }),
        res,
        { bot, fetchImpl, awaitFollowup: true },
      );
      expect((calls[0].body as { content?: string }).content).toMatch(/Sign in with Discord/i);
    });
  });

  describe('/offering — slash submission', () => {
    it('happy path: inserts available_items + card_signals, posts embed', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-off-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const bot = makeSignalBot();
      const { fetchImpl } = captureFollowup();
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'offering',
          guildId,
          channelId: 'ch-off',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
          qty: 1,
          maxPrice: 8,
        }),
        res,
        { bot, fetchImpl, awaitFollowup: true },
      );

      const db = getDb();
      const [availRow] = await db
        .select()
        .from(availableItems)
        .where(eq(availableItems.userId, signaler.id))
        .limit(1);
      expect(availRow).toBeTruthy();
      expect(availRow.productId).toBe(STABLE_PRODUCT_ID);

      const [signalRow] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.userId, signaler.id))
        .limit(1);
      expect(signalRow.kind).toBe('offering');
      expect(signalRow.maxUnitPrice).toBe('8');
      signalIds.push(signalRow.id);

      const embed = bot.postCalls[0].body.embeds?.[0];
      expect(embed?.title).toMatch(/Offering/);
    });
  });

  describe('signal:<id>:cancel button', () => {
    it('owner can cancel — sets status=cancelled and PATCHes embed via type-7', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-can-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      // Send /looking-for so a signal exists.
      const bot1 = makeSignalBot();
      const { fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-cancel',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot: bot1, fetchImpl, awaitFollowup: true },
      );
      const db = getDb();
      const [signal] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.userId, signaler.id))
        .limit(1);
      signalIds.push(signal.id);

      // Click Cancel as the signaler.
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3, // MESSAGE_COMPONENT
          data: { custom_id: `signal:${signal.id}:cancel` },
          member: { user: { id: signaler.id } },
        },
        res,
      );

      expect(res._status).toBe(200);
      expect((res._json as { type: number }).type).toBe(7); // UPDATE_MESSAGE

      const [after] = await db
        .select({ status: cardSignals.status, cancelledAt: cardSignals.cancelledAt })
        .from(cardSignals)
        .where(eq(cardSignals.id, signal.id))
        .limit(1);
      expect(after.status).toBe('cancelled');
      expect(after.cancelledAt).not.toBeNull();
    });

    it('non-owner cannot cancel — gets ephemeral error', async () => {
      const signaler = await createTestUser();
      const stranger = await createTestUser();
      fixtures.push(signaler, stranger);
      const guildId = `g-noc-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const { fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-noc',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      const db = getDb();
      const [signal] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.userId, signaler.id))
        .limit(1);
      signalIds.push(signal.id);

      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${signal.id}:cancel` },
          member: { user: { id: stranger.id } },
        },
        res,
      );

      expect(res._status).toBe(200);
      const body = res._json as { type: number; data?: { content?: string } };
      expect(body.type).toBe(4); // CHANNEL_MESSAGE — ephemeral error
      expect(body.data?.content).toMatch(/Only the post's author/i);

      // Status unchanged.
      const [after] = await db
        .select({ status: cardSignals.status })
        .from(cardSignals)
        .where(eq(cardSignals.id, signal.id))
        .limit(1);
      expect(after.status).toBe('active');
    });
  });

  describe('variant flow', () => {
    it('slash with variant arg pins the wants_items restriction up-front', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-var-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const bot = makeSignalBot();
      const { fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-var',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
          variant: 'Hyperspace',
        }),
        mockResponse(),
        { bot, fetchImpl, awaitFollowup: true },
      );

      const db = getDb();
      const [wantsRow] = await db
        .select()
        .from(wantsItems)
        .where(eq(wantsItems.userId, signaler.id))
        .limit(1);
      expect(wantsRow.restrictionMode).toBe('restricted');
      expect(wantsRow.restrictionVariants).toEqual(['Hyperspace']);

      const [signal] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.userId, signaler.id))
        .limit(1);
      signalIds.push(signal.id);
    });

    it('signal:<id>:variant-open opens an ephemeral picker (owner-only)', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-vo-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const { fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-vo',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      const db = getDb();
      const [signal] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.userId, signaler.id))
        .limit(1);
      signalIds.push(signal.id);

      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${signal.id}:variant-open` },
          member: { user: { id: signaler.id } },
        },
        res,
      );

      expect(res._status).toBe(200);
      const body = res._json as {
        type: number;
        data?: { content?: string; flags?: number; components?: Array<{ components?: Array<{ type: number; options?: unknown[] }> }> };
      };
      expect(body.type).toBe(4);
      expect(body.data?.flags).toBe(64);
      expect(body.data?.content).toMatch(/Specify the variant/i);
      // String-select with variant options.
      const select = body.data?.components?.[0]?.components?.[0];
      expect(select?.type).toBe(3);
      expect((select?.options ?? []).length).toBeGreaterThan(0);
    });

    it('signal:<id>:variant-pick narrows the wants_items restriction + responds with confirmation', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-vp-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const { fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-vp',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      const db = getDb();
      const [signal] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.userId, signaler.id))
        .limit(1);
      signalIds.push(signal.id);

      // The variant-pick handler PATCHes the public post via the
      // bot client to reflect the new variant. Inject a fake so
      // the test doesn't need DISCORD_BOT_TOKEN at module init.
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${signal.id}:variant-pick`, values: ['Hyperspace'] },
          member: { user: { id: signaler.id } },
        },
        res,
        { bot: makeSignalBot() },
      );

      expect(res._status).toBe(200);
      // Type 7 — UPDATE_MESSAGE — replaces the ephemeral picker
      // with a confirmation.
      expect((res._json as { type: number }).type).toBe(7);

      // The wants_items row should now have restricted variant.
      const [wantsRow] = await db
        .select()
        .from(wantsItems)
        .where(eq(wantsItems.userId, signaler.id))
        .limit(1);
      expect(wantsRow.restrictionMode).toBe('restricted');
      expect(wantsRow.restrictionVariants).toEqual(['Hyperspace']);
    });
  });

  describe('match-ping integration', () => {
    it('DMs a guild member who has the wanted card available, gated on dmMatchAlerts', async () => {
      const signaler = await createTestUser();
      const matcher = await createTestUser();
      fixtures.push(signaler, matcher);
      const guildId = `g-match-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await createMutualGuildMembership(signaler.id, matcher.id, guildId));

      // Seed the matcher's available list with the product the
      // signal will be looking for.
      const db = getDb();
      const availId = `a-test-${matcher.id}`;
      await db.insert(availableItems).values({
        id: availId,
        userId: matcher.id,
        productId: STABLE_PRODUCT_ID,
        qty: 1,
        addedAt: Date.now(),
      });

      // Enable match alerts on the matcher.
      await db.update(users)
        .set({ dmMatchAlerts: true })
        .where(eq(users.id, matcher.id));

      const bot = makeSignalBot();
      const { fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-match',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot, fetchImpl, awaitFollowup: true },
      );

      expect(bot.sendCalls).toHaveLength(1);
      expect(bot.sendCalls[0].userId).toBe(matcher.id);
      expect(bot.sendCalls[0].body.content).toMatch(/looking for/i);

      const [signal] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.userId, signaler.id))
        .limit(1);
      signalIds.push(signal.id);
      await db.delete(availableItems).where(eq(availableItems.id, availId));
    });

    it('does NOT DM when matcher has dmMatchAlerts off (default)', async () => {
      const signaler = await createTestUser();
      const matcher = await createTestUser();
      fixtures.push(signaler, matcher);
      const guildId = `g-noping-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await createMutualGuildMembership(signaler.id, matcher.id, guildId));

      const db = getDb();
      const availId = `a-test-${matcher.id}`;
      await db.insert(availableItems).values({
        id: availId,
        userId: matcher.id,
        productId: STABLE_PRODUCT_ID,
        qty: 1,
        addedAt: Date.now(),
      });
      // dmMatchAlerts defaults to false — don't enable.

      const bot = makeSignalBot();
      const { fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-noping',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot, fetchImpl, awaitFollowup: true },
      );

      expect(bot.sendCalls).toHaveLength(0);

      const [signal] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.userId, signaler.id))
        .limit(1);
      signalIds.push(signal.id);
      await db.delete(availableItems).where(eq(availableItems.id, availId));
    });
  });
});
