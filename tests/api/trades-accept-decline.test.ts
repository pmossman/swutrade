import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleAcceptDecline } from '../../api/trades.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import {
  tradeProposals,
  proposalEvents,
  type TradeCardSnapshot,
} from '../../lib/schema.js';
import type { DiscordBotClient, DiscordMessageBody } from '../../lib/discordBot.js';

/**
 * Web-surface accept/decline — the JSON counterpart to the Discord
 * button handler. Both paths funnel through `resolveProposal`, so
 * this suite exercises the shared state transition + event log +
 * proposer-notification + DM-edit behavior via the web entry point.
 *
 * The Discord-button path itself is covered by `bot.test.ts`; what
 * we verify here is that the HTTP handler maps the resolver outcomes
 * to the right status codes AND that the shared Discord side effects
 * still fire when the web path drives the transition.
 */

function snapshot(productId: string, qty = 1): TradeCardSnapshot {
  return { productId, name: `Card ${productId}`, variant: 'Standard', qty, unitPrice: 1.0 };
}

function makeFakeBot(opts: { editFails?: boolean; sendFails?: boolean } = {}): DiscordBotClient & {
  editCalls: Array<{ channelId: string; messageId: string; body: DiscordMessageBody }>;
  sendCalls: Array<{ userId: string; body: DiscordMessageBody }>;
} {
  const editCalls: Array<{ channelId: string; messageId: string; body: DiscordMessageBody }> = [];
  const sendCalls: Array<{ userId: string; body: DiscordMessageBody }> = [];
  return {
    editCalls,
    sendCalls,
    async postChannelMessage() { throw new Error('unused'); },
    async editChannelMessage(channelId, messageId, body) {
      editCalls.push({ channelId, messageId, body });
      if (opts.editFails) throw new Error('simulated edit failure');
    },
    async createDmChannel() { return { id: 'dm-accept' }; },
    async sendDirectMessage(userId, body) {
      sendCalls.push({ userId, body });
      if (opts.sendFails) throw new Error('simulated send failure');
      return { id: 'notify-msg-1', channel_id: 'dm-accept' };
    },
    async getGuild() { throw new Error('unused'); },
    async createPrivateThread() { throw new Error('unused'); },
    async addThreadMember() { throw new Error('unused'); },
    async deleteChannel() { throw new Error('unused'); },
    async createGuildChannel() { throw new Error('unused'); },
    async getGuildBotMember() { throw new Error('unused'); },
  };
}

async function seedProposal(overrides: {
  proposerUserId: string;
  recipientUserId: string;
  status?: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'countered';
  discordDmChannelId?: string | null;
  discordDmMessageId?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb();
  await db.insert(tradeProposals).values({
    id,
    proposerUserId: overrides.proposerUserId,
    recipientUserId: overrides.recipientUserId,
    status: overrides.status ?? 'pending',
    offeringCards: [snapshot('p-1', 2)],
    receivingCards: [snapshot('p-2', 1)],
    message: null,
    deliveryStatus: 'delivered',
    discordDmChannelId: overrides.discordDmChannelId ?? 'dm-ad-x',
    discordDmMessageId: overrides.discordDmMessageId ?? 'msg-ad-x',
  });
  return id;
}

describeWithDb('POST /api/trades?action=accept|decline', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const createdIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of createdIds) {
      await db.delete(proposalEvents).where(eq(proposalEvents.proposalId, id)).catch(() => {});
      await db.delete(tradeProposals).where(eq(tradeProposals.id, id)).catch(() => {});
    }
    createdIds.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('401 when unauthenticated', async () => {
    const req = mockRequest({ method: 'POST', body: { id: 'anything' } });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'accepted', { bot: makeFakeBot() });
    expect(res._status).toBe(401);
  });

  it('400 on missing id', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'POST', cookies: { swu_session: cookie }, body: {} });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'accepted', { bot: makeFakeBot() });
    expect(res._status).toBe(400);
  });

  it('accept happy path: 200 + status flips + event recorded + DM edited + proposer notified', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'accepted', { bot });

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ id, status: 'accepted' });

    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
    expect(row.status).toBe('accepted');
    expect(row.respondedAt).not.toBeNull();

    // Event log: one 'accepted' row for this proposal, actor = recipient.
    const events = await db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, id));
    const accepted = events.find(e => e.type === 'accepted');
    expect(accepted).toBeTruthy();
    expect(accepted?.actorUserId).toBe(recipient.id);

    // DM edited in place (buttons stripped → components: []).
    expect(bot.editCalls).toHaveLength(1);
    expect(bot.editCalls[0].channelId).toBe('dm-ad-x');
    expect(bot.editCalls[0].messageId).toBe('msg-ad-x');
    expect(bot.editCalls[0].body.components).toEqual([]);

    // Proposer notified.
    expect(bot.sendCalls).toHaveLength(1);
    expect(bot.sendCalls[0].userId).toBe(proposer.id);
    expect(bot.sendCalls[0].body.embeds?.[0].title).toMatch(/accepted/i);
  });

  it('decline happy path: 200 + status flips + proposer DM says "declined"', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'declined', { bot });

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ id, status: 'declined' });

    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
    expect(row.status).toBe('declined');

    // Event recorded with type='declined'.
    const events = await db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, id));
    expect(events.some(e => e.type === 'declined')).toBe(true);

    // Proposer DM mentions declined.
    expect(bot.sendCalls).toHaveLength(1);
    expect(bot.sendCalls[0].body.embeds?.[0].title).toMatch(/declined/i);
  });

  it('non-recipient attempt returns 404 (no existence leak, no state change)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    const intruder = await createTestUser();
    fixtures.push(proposer, recipient, intruder);

    const id = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(intruder.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'accepted', { bot });

    expect(res._status).toBe(404);

    // Trade unchanged.
    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
    expect(row.status).toBe('pending');

    // No Discord side effects.
    expect(bot.editCalls).toHaveLength(0);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('also returns 404 (not 403) when the proposer tries to accept their own proposal — same shape as non-recipient', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const cookie = await sealTestCookie(proposer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'accepted', { bot: makeFakeBot() });

    expect(res._status).toBe(404);
  });

  it('409 when already-resolved (accept attempt on already-accepted proposal)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id = await seedProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'accepted',
    });
    createdIds.push(id);

    const bot = makeFakeBot();
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'accepted', { bot });

    expect(res._status).toBe(409);

    // No side effects fired — status was already resolved.
    expect(bot.editCalls).toHaveLength(0);
    expect(bot.sendCalls).toHaveLength(0);
  });

  it('409 when declined-then-declined (double submit race on an already-resolved proposal)', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id = await seedProposal({
      proposerUserId: proposer.id,
      recipientUserId: recipient.id,
      status: 'declined',
    });
    createdIds.push(id);

    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'declined', { bot: makeFakeBot() });
    expect(res._status).toBe(409);
  });

  it('404 on unknown proposal id (folded with non-recipient — no existence leak)', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id: '00000000-0000-0000-0000-000000000000' },
    });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'accepted', { bot: makeFakeBot() });
    expect(res._status).toBe(404);
  });

  it('DM edit failure does not block the transition — caller gets 200, status still flips, event still recorded', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const bot = makeFakeBot({ editFails: true });
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'accepted', { bot });

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ id, status: 'accepted' });

    // DB committed.
    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
    expect(row.status).toBe('accepted');

    // Event still recorded.
    const events = await db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, id));
    expect(events.some(e => e.type === 'accepted')).toBe(true);

    // Edit attempt was made (and failed); the proposer still got notified.
    expect(bot.editCalls).toHaveLength(1);
    expect(bot.sendCalls).toHaveLength(1);
  });

  it('proposer-notify failure does not block the transition either — 200 + committed + event recorded', async () => {
    const proposer = await createTestUser();
    const recipient = await createTestUser();
    fixtures.push(proposer, recipient);

    const id = await seedProposal({ proposerUserId: proposer.id, recipientUserId: recipient.id });
    createdIds.push(id);

    const bot = makeFakeBot({ sendFails: true });
    const cookie = await sealTestCookie(recipient.id);
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: { id },
    });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'declined', { bot });

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ id, status: 'declined' });

    const db = getDb();
    const [row] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).limit(1);
    expect(row.status).toBe('declined');

    const events = await db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, id));
    expect(events.some(e => e.type === 'declined')).toBe(true);

    expect(bot.sendCalls).toHaveLength(1); // attempted
    // Edit still ran successfully (only send is forced to fail).
    expect(bot.editCalls).toHaveLength(1);
  });

  it('405 on non-POST method', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleAcceptDecline(req, res, 'accepted', { bot: makeFakeBot() });
    expect(res._status).toBe(405);
  });
});
