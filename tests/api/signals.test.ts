import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { dispatchBotPayload } from '../../api/bot.js';
import {
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
 * Integration coverage for the multi-card slash + preview/confirm
 * flow. Slash commands now create `draft` signals + ephemeral
 * preview; the public post lands only when the author clicks
 * Confirm. Match listings live in the post itself (no auto-DMs).
 *
 * STABLE_FAMILY_ID is Luke Skywalker - Hero of Yavin (jump-to-
 * lightspeed). STABLE_PRODUCT_ID is its Standard product.
 * Used as a stable card across many e2e specs.
 */

const STABLE_FAMILY_ID = 'jump-to-lightspeed::luke-skywalker-hero-of-yavin';
const STABLE_PRODUCT_ID = '617180';
// Second canonical family for multi-card tests — Aggressive
// Negotiations from Secrets of Power.
const SECONDARY_FAMILY_ID = 'secrets-of-power::aggressive-negotiations';

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
  familyId: string;
  /** Additional family ids → become card2..card5. */
  additionalFamilyIds?: string[];
  variant?: string;
  qty?: number;
  note?: string;
  maxPrice?: number;
}) {
  const options: Array<{ name: string; type: number; value: unknown }> = [
    { name: 'card', type: 3, value: opts.familyId },
  ];
  for (let i = 0; i < (opts.additionalFamilyIds?.length ?? 0); i++) {
    options.push({ name: `card${i + 2}`, type: 3, value: opts.additionalFamilyIds![i] });
  }
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

describeWithDb('signals: slash + preview + confirm/cancel + variant', () => {
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

  describe('slash creates draft + returns preview ephemeral', () => {
    it('happy path: inserts draft signal + preview embed contains card + Confirm/Cancel buttons (no public post yet)', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
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

      // Sync response is the deferred ack.
      expect(res._status).toBe(200);
      expect((res._json as { type: number }).type).toBe(5);

      // Ephemeral preview followup — no public post yet.
      expect(bot.postCalls).toHaveLength(0);
      expect(calls).toHaveLength(1);
      const preview = calls[0].body as {
        flags?: number;
        embeds?: Array<{ title?: string; description?: string }>;
        components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }>;
      };
      expect(preview.flags).toBe(64);
      // Title + description reflect the slash inputs.
      expect(preview.embeds?.[0]?.title).toMatch(/Looking for/);
      expect(preview.embeds?.[0]?.description).toContain('2×');
      expect(preview.embeds?.[0]?.description).toMatch(/for Friday's draft/);
      // Confirm + Cancel buttons present.
      const buttons = preview.components?.[0]?.components ?? [];
      const labels = buttons.map(b => b.label);
      expect(labels).toContain('Confirm & post');
      expect(labels).toContain('Cancel');
      // Confirm button's custom_id carries the groupId.
      const confirmBtn = buttons.find(b => b.label === 'Confirm & post');
      expect(confirmBtn?.custom_id).toMatch(/^signal:[^:]+:confirm-draft$/);
      const groupId = confirmBtn!.custom_id!.split(':')[1];
      groupIds.push(groupId);

      // Draft row exists.
      const db = getDb();
      const drafts = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.groupId, groupId));
      expect(drafts).toHaveLength(1);
      expect(drafts[0].status).toBe('draft');
      expect(drafts[0].kind).toBe('wanted');
      expect(drafts[0].guildId).toBe(guildId);
      expect(drafts[0].messageId).toBeNull();  // not posted yet
    });

    it('multi-card: card + card2 + card3 → 3 draft rows in one group', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-mc-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const bot = makeSignalBot();
      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-mc',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
          additionalFamilyIds: [SECONDARY_FAMILY_ID],
        }),
        mockResponse(),
        { bot, fetchImpl, awaitFollowup: true },
      );

      const preview = calls[0].body as {
        components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }>;
      };
      const groupId = preview.components?.[0]?.components?.find(b => b.label === 'Confirm & post')?.custom_id?.split(':')[1];
      expect(groupId).toBeTruthy();
      groupIds.push(groupId!);

      const db = getDb();
      const drafts = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.groupId, groupId!));
      expect(drafts).toHaveLength(2);
      expect(drafts.every(d => d.status === 'draft')).toBe(true);
      expect(drafts.every(d => d.groupId === groupId)).toBe(true);
    });

    it('rejects when not in a guild (DM context)', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        {
          type: 2,
          application_id: 'app-test',
          token: 'tok-test',
          channel_id: 'ch-dm',
          user: { id: signaler.id },
          data: { type: 1, name: 'looking-for', options: [{ name: 'card', type: 3, value: STABLE_FAMILY_ID }] },
        },
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      expect((calls[0].body as { content?: string }).content).toMatch(/only work inside a server/i);
    });

    it('rejects when bot is not installed in the guild', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId: 'g-uninstalled',
          channelId: 'ch-1',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      expect((calls[0].body as { content?: string }).content).toMatch(/SWUTrade isn't installed/i);
    });

    it('rejects when slash author isn\'t a SWUTrade user', async () => {
      const guildId = `g-noauth-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-1',
          clickerDiscordId: 'discord-id-without-swutrade-account',
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      expect((calls[0].body as { content?: string }).content).toMatch(/Sign in with Discord/i);
    });
  });

  describe('confirm-draft button', () => {
    it('owner can confirm: posts public message, flips drafts to active, replaces ephemeral with link', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-cd-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      // Slash → draft.
      const bot1 = makeSignalBot();
      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-cd',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot: bot1, fetchImpl, awaitFollowup: true },
      );
      const groupId = (calls[0].body as { components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }> })
        .components?.[0]?.components?.find(b => b.label === 'Confirm & post')?.custom_id?.split(':')[1]!;
      groupIds.push(groupId);

      // Confirm button click.
      const bot2 = makeSignalBot({ postId: 'public-post-1' });
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${groupId}:confirm-draft` },
          member: { user: { id: signaler.id } },
        },
        res,
        { bot: bot2 },
      );

      // Bot posted the public embed.
      expect(bot2.postCalls).toHaveLength(1);
      expect(bot2.postCalls[0].channelId).toBe('ch-cd');

      // Ephemeral was replaced with a "Posted!" body via type-7.
      expect(res._status).toBe(200);
      expect((res._json as { type: number }).type).toBe(7);
      expect((res._json as { data?: { content?: string } }).data?.content).toMatch(/Posted!/);

      // DB row is now active + has messageId.
      const db = getDb();
      const [signal] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.groupId, groupId))
        .limit(1);
      expect(signal.status).toBe('active');
      expect(signal.messageId).toBe('public-post-1');
    });

    it('non-owner cannot confirm — gets ephemeral error', async () => {
      const signaler = await createTestUser();
      const stranger = await createTestUser();
      fixtures.push(signaler, stranger);
      const guildId = `g-cdno-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-cdno',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      const groupId = (calls[0].body as { components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }> })
        .components?.[0]?.components?.find(b => b.label === 'Confirm & post')?.custom_id?.split(':')[1]!;
      groupIds.push(groupId);

      const bot = makeSignalBot();
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${groupId}:confirm-draft` },
          member: { user: { id: stranger.id } },
        },
        res,
        { bot },
      );

      expect(bot.postCalls).toHaveLength(0);
      expect((res._json as { type: number }).type).toBe(4);
      expect((res._json as { data?: { content?: string } }).data?.content).toMatch(/Only the post's author/i);

      // Draft still in draft state.
      const db = getDb();
      const [signal] = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.groupId, groupId))
        .limit(1);
      expect(signal.status).toBe('draft');
    });
  });

  describe('cancel-draft button', () => {
    it('owner can discard: deletes drafts, edits ephemeral to "Cancelled"', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-xd-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-xd',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      const groupId = (calls[0].body as { components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }> })
        .components?.[0]?.components?.find(b => b.label === 'Confirm & post')?.custom_id?.split(':')[1]!;

      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${groupId}:cancel-draft` },
          member: { user: { id: signaler.id } },
        },
        res,
      );

      expect((res._json as { type: number }).type).toBe(7);
      expect((res._json as { data?: { content?: string } }).data?.content).toMatch(/Cancelled/i);

      // Drafts deleted.
      const db = getDb();
      const remaining = await db
        .select()
        .from(cardSignals)
        .where(eq(cardSignals.groupId, groupId));
      expect(remaining).toHaveLength(0);
    });
  });

  describe('cancel (live post) button — group-aware', () => {
    it('owner can cancel a live group: every row → cancelled, embed PATCHed via type-7', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-cl-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      // Slash → draft → confirm to live.
      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-cl',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
          additionalFamilyIds: [SECONDARY_FAMILY_ID],
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      const groupId = (calls[0].body as { components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }> })
        .components?.[0]?.components?.find(b => b.label === 'Confirm & post')?.custom_id?.split(':')[1]!;
      groupIds.push(groupId);

      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${groupId}:confirm-draft` },
          member: { user: { id: signaler.id } },
        },
        mockResponse(),
        { bot: makeSignalBot({ postId: 'live-post-1' }) },
      );

      // Click Cancel post on the live group.
      const res = mockResponse();
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${groupId}:cancel` },
          member: { user: { id: signaler.id } },
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
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.status).toBe('cancelled');
    });
  });

  describe('match listing in preview + post', () => {
    it('preview lists guild members who match the signal (no DM-pings)', async () => {
      const signaler = await createTestUser();
      const matcher = await createTestUser();
      fixtures.push(signaler, matcher);
      const guildId = `g-mlp-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await createMutualGuildMembership(signaler.id, matcher.id, guildId));

      // Seed the matcher's available row.
      const db = getDb();
      const availId = `a-test-${matcher.id}`;
      await db.insert(availableItems).values({
        id: availId,
        userId: matcher.id,
        productId: STABLE_PRODUCT_ID,
        qty: 1,
        addedAt: Date.now(),
      });

      const bot = makeSignalBot();
      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-mlp',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot, fetchImpl, awaitFollowup: true },
      );

      // No DMs sent — matches are public surface only.
      expect(bot.sendCalls).toHaveLength(0);

      // Preview embed mentions the matcher.
      const preview = calls[0].body as { embeds?: Array<{ description?: string }> };
      expect(preview.embeds?.[0]?.description).toContain(`<@${matcher.id}>`);

      // Cleanup.
      const groupId = (calls[0].body as { components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }> })
        .components?.[0]?.components?.find(b => b.label === 'Confirm & post')?.custom_id?.split(':')[1]!;
      groupIds.push(groupId);
      await db.delete(availableItems).where(eq(availableItems.id, availId));
    });
  });

  describe('variant flow (single-card live post only)', () => {
    it('variant button only renders when single-card + variant=any', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-vbtn-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      // Slash → preview → confirm to live (single-card, variant=any).
      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-vbtn',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      const groupId = (calls[0].body as { components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }> })
        .components?.[0]?.components?.find(b => b.label === 'Confirm & post')?.custom_id?.split(':')[1]!;
      groupIds.push(groupId);

      const confirmBot = makeSignalBot({ postId: 'live-vbtn' });
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${groupId}:confirm-draft` },
          member: { user: { id: signaler.id } },
        },
        mockResponse(),
        { bot: confirmBot },
      );

      // The public post embed has BOTH Specify variant + Cancel post buttons.
      const liveEmbed = confirmBot.postCalls[0].body as {
        components?: Array<{ components?: Array<{ label?: string; custom_id?: string }> }>;
      };
      const liveButtons = (liveEmbed.components?.[0]?.components ?? []).map(b => b.label);
      expect(liveButtons).toContain('Specify variant');
      expect(liveButtons).toContain('Cancel post');
    });

    it('multi-card group does NOT show Specify variant button', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-mcv-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-mcv',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
          additionalFamilyIds: [SECONDARY_FAMILY_ID],
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      const groupId = (calls[0].body as { components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }> })
        .components?.[0]?.components?.find(b => b.label === 'Confirm & post')?.custom_id?.split(':')[1]!;
      groupIds.push(groupId);

      const confirmBot = makeSignalBot({ postId: 'live-mcv' });
      await dispatchBotPayload(
        'interactions',
        {
          type: 3,
          data: { custom_id: `signal:${groupId}:confirm-draft` },
          member: { user: { id: signaler.id } },
        },
        mockResponse(),
        { bot: confirmBot },
      );

      const liveEmbed = confirmBot.postCalls[0].body as {
        components?: Array<{ components?: Array<{ label?: string }> }>;
      };
      const liveButtons = (liveEmbed.components?.[0]?.components ?? []).map(b => b.label);
      expect(liveButtons).not.toContain('Specify variant');
      expect(liveButtons).toContain('Cancel post');
    });
  });

  describe('initial slash with variant arg pins the wants_items restriction up-front', () => {
    it('variant=Hyperspace produces a restricted wants row', async () => {
      const signaler = await createTestUser();
      fixtures.push(signaler);
      const guildId = `g-vfront-${Math.random().toString(36).slice(2, 8)}`;
      guildCleanups.push(await installBotInGuild(guildId));
      guildCleanups.push(await createGuildMembership(signaler.id, guildId));

      const { calls, fetchImpl } = captureFollowup();
      await dispatchBotPayload(
        'interactions',
        buildSignalPayload({
          command: 'looking-for',
          guildId,
          channelId: 'ch-vfront',
          clickerDiscordId: signaler.id,
          familyId: STABLE_FAMILY_ID,
          variant: 'Hyperspace',
        }),
        mockResponse(),
        { bot: makeSignalBot(), fetchImpl, awaitFollowup: true },
      );
      const groupId = (calls[0].body as { components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }> })
        .components?.[0]?.components?.find(b => b.label === 'Confirm & post')?.custom_id?.split(':')[1]!;
      groupIds.push(groupId);

      const db = getDb();
      const [wantsRow] = await db
        .select()
        .from(wantsItems)
        .where(eq(wantsItems.userId, signaler.id))
        .limit(1);
      expect(wantsRow.restrictionMode).toBe('restricted');
      expect(wantsRow.restrictionVariants).toEqual(['Hyperspace']);
    });
  });
});
