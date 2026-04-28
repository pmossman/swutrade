import { describeWithDb } from '../api/helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createTestUser,
  createMutualGuildMembership,
  createGuildMembership,
  installBotInGuild,
} from '../api/helpers.js';
import { getDb } from '../../lib/db.js';
import { tradeProposals, botInstalledGuilds } from '../../lib/schema.js';
import {
  listMutualBotGuilds,
  resolveTradeGuild,
  getGuildTradesChannel,
} from '../../lib/tradeGuild.js';

/**
 * Tests for the per-guild trade-thread router. Exercises the
 * SQL-backed candidate set + the cascade tiebreaker + the
 * preferred-guild override.
 */
describeWithDb('lib/tradeGuild', () => {
  const cleanups: Array<() => Promise<void>> = [];
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const seededProposalIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of seededProposalIds) {
      await db.delete(tradeProposals).where(eq(tradeProposals.id, id)).catch(() => {});
    }
    seededProposalIds.length = 0;
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  describe('listMutualBotGuilds', () => {
    it('returns empty when neither user shares a bot-installed guild', async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      fixtures.push(a, b);

      const result = await listMutualBotGuilds(getDb(), a.id, b.id);
      expect(result).toEqual([]);
    });

    it('skips guilds without a tradesChannelId — install predates the auto-create feature', async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      fixtures.push(a, b);

      // Bot installed but no channel ever provisioned.
      cleanups.push(await createMutualGuildMembership(a.id, b.id, 'g-noch', {
        tradesChannelId: null,
      }));

      const result = await listMutualBotGuilds(getDb(), a.id, b.id);
      expect(result).toEqual([]);
    });

    it('returns a single guild when only one mutual bot-installed guild qualifies — marked as default', async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      fixtures.push(a, b);

      cleanups.push(await createMutualGuildMembership(a.id, b.id, 'g-only', {
        tradesChannelId: 'channel-only',
      }));

      const result = await listMutualBotGuilds(getDb(), a.id, b.id);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        guildId: 'g-only',
        tradesChannelId: 'channel-only',
        isDefault: true,
      });
    });

    it('does not include guilds where only ONE party is a member', async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      const c = await createTestUser();
      fixtures.push(a, b, c);

      // a + b share g-shared. a + c share g-only-a.
      cleanups.push(await createMutualGuildMembership(a.id, b.id, 'g-shared', {
        tradesChannelId: 'ch-shared',
      }));
      cleanups.push(await installBotInGuild('g-only-a', { tradesChannelId: 'ch-only-a' }));
      cleanups.push(await createGuildMembership(a.id, 'g-only-a'));
      cleanups.push(await createGuildMembership(c.id, 'g-only-a'));

      const result = await listMutualBotGuilds(getDb(), a.id, b.id);
      expect(result).toHaveLength(1);
      expect(result[0].guildId).toBe('g-shared');
    });

    it('cascade: most-recent prior trade between THIS pair beats install recency', async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      fixtures.push(a, b);

      // Two guilds share both users. g-old has the older bot install.
      // g-new has the newer install. Default WITHOUT prior trades:
      // newer install wins (g-new). But seed a prior trade in g-old —
      // that should override.
      cleanups.push(await createMutualGuildMembership(a.id, b.id, 'g-old', {
        tradesChannelId: 'ch-old',
      }));
      cleanups.push(await createMutualGuildMembership(a.id, b.id, 'g-new', {
        tradesChannelId: 'ch-new',
      }));
      // Push g-new's installedAt to most-recent so "install recency"
      // would otherwise pick it.
      const db = getDb();
      await db.update(botInstalledGuilds)
        .set({ installedAt: sql`now() + interval '1 hour'` })
        .where(eq(botInstalledGuilds.guildId, 'g-new'));

      // Pre-cascade: g-new wins on install recency.
      const beforeTrade = await listMutualBotGuilds(db, a.id, b.id);
      expect(beforeTrade[0].guildId).toBe('g-new');

      // Seed a prior trade in g-old.
      const tradeId = `t-prior-${Math.random().toString(36).slice(2, 8)}`;
      await db.insert(tradeProposals).values({
        id: tradeId,
        proposerUserId: a.id,
        recipientUserId: b.id,
        status: 'accepted',
        offeringCards: [],
        receivingCards: [],
        deliveryStatus: 'delivered',
        guildId: 'g-old',
      });
      seededProposalIds.push(tradeId);

      // Post-cascade: g-old wins on "we traded here before".
      const afterTrade = await listMutualBotGuilds(db, a.id, b.id);
      expect(afterTrade[0].guildId).toBe('g-old');
      expect(afterTrade[0].isDefault).toBe(true);
      expect(afterTrade[1].guildId).toBe('g-new');
      expect(afterTrade[1].isDefault).toBe(false);
    });

    it('lexicographic last-resort tiebreaker when nothing else differs', async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      fixtures.push(a, b);

      cleanups.push(await createMutualGuildMembership(a.id, b.id, 'g-xxx', {
        tradesChannelId: 'ch-xxx',
      }));
      cleanups.push(await createMutualGuildMembership(a.id, b.id, 'g-aaa', {
        tradesChannelId: 'ch-aaa',
      }));

      // Pin both installedAt to the same timestamp so the cascade
      // falls all the way to lexicographic.
      const db = getDb();
      await db.update(botInstalledGuilds)
        .set({ installedAt: new Date('2026-01-01T00:00:00Z') });

      const result = await listMutualBotGuilds(db, a.id, b.id);
      expect(result[0].guildId).toBe('g-aaa');
    });
  });

  describe('resolveTradeGuild', () => {
    it('returns null when no candidate guild exists — caller falls back to DM', async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      fixtures.push(a, b);

      const result = await resolveTradeGuild(getDb(), a.id, b.id);
      expect(result).toBeNull();
    });

    it('honours preferredGuildId when it qualifies', async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      fixtures.push(a, b);

      cleanups.push(await createMutualGuildMembership(a.id, b.id, 'g-1', {
        tradesChannelId: 'ch-1',
      }));
      cleanups.push(await createMutualGuildMembership(a.id, b.id, 'g-2', {
        tradesChannelId: 'ch-2',
      }));

      const result = await resolveTradeGuild(getDb(), a.id, b.id, 'g-2');
      expect(result).toMatchObject({ guildId: 'g-2', tradesChannelId: 'ch-2' });
    });

    it('falls through to default when preferredGuildId does not qualify (stale UI cache)', async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      fixtures.push(a, b);

      cleanups.push(await createMutualGuildMembership(a.id, b.id, 'g-1', {
        tradesChannelId: 'ch-1',
      }));
      // Caller asks for g-rogue which neither user is in. Don't fail
      // — degrade to the default.
      const result = await resolveTradeGuild(getDb(), a.id, b.id, 'g-rogue');
      expect(result).toMatchObject({ guildId: 'g-1' });
    });
  });

  describe('getGuildTradesChannel', () => {
    it('returns the channel id for an installed guild', async () => {
      cleanups.push(await installBotInGuild('g-q', { tradesChannelId: 'ch-q' }));
      expect(await getGuildTradesChannel(getDb(), 'g-q')).toBe('ch-q');
    });

    it('returns null when the guild is no longer installed', async () => {
      expect(await getGuildTradesChannel(getDb(), 'g-uninstalled')).toBeNull();
    });
  });
});
