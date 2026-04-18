import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { syncGuildMemberships } from '../../lib/guildSync.js';
import { getDb } from '../../lib/db.js';
import { userGuildMemberships } from '../../lib/schema.js';
import { createTestUser, createFakeDiscordClient, createGuildMembership, installBotInGuild } from './helpers.js';

describeWithDb('syncGuildMemberships', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const db = getDb();
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
    for (const f of fixtures) {
      await db.delete(userGuildMemberships).where(eq(userGuildMemberships.userId, f.id)).catch(() => {});
      await f.cleanup();
    }
    fixtures.length = 0;
  });

  describe('upsert behaviour', () => {
    it('inserts rows for each returned guild', async () => {
      const user = await createTestUser();
      fixtures.push(user);

      const discord = createFakeDiscordClient({
        'token-1': [
          { id: 'g1', name: 'Star Wars SD', icon: 'abc', permissions: '0' },
          { id: 'g2', name: 'Another', icon: null, permissions: '0' },
        ],
      });

      await syncGuildMemberships(user.id, 'token-1', discord);

      const db = getDb();
      const rows = await db.select().from(userGuildMemberships).where(eq(userGuildMemberships.userId, user.id));
      expect(rows).toHaveLength(2);
      expect(rows.map(r => r.guildId).sort()).toEqual(['g1', 'g2']);
    });

    it('sets canManage=true when MANAGE_GUILD (0x20) is in the permissions bitfield', async () => {
      const user = await createTestUser();
      fixtures.push(user);

      const discord = createFakeDiscordClient({
        'tok': [
          // MANAGE_GUILD (bit 5) + VIEW_CHANNEL (bit 10)
          { id: 'admin-guild', name: 'Admin Guild', icon: null, permissions: String(0x20 | 0x400) },
          // No MANAGE_GUILD
          { id: 'member-guild', name: 'Member Guild', icon: null, permissions: String(0x400) },
        ],
      });

      await syncGuildMemberships(user.id, 'tok', discord);

      const db = getDb();
      const rows = await db.select().from(userGuildMemberships).where(eq(userGuildMemberships.userId, user.id));
      const admin = rows.find(r => r.guildId === 'admin-guild');
      const member = rows.find(r => r.guildId === 'member-guild');
      expect(admin?.canManage).toBe(true);
      expect(member?.canManage).toBe(false);
    });

    it('auto-enrolls new memberships in guilds where the bot is installed', async () => {
      const user = await createTestUser();
      fixtures.push(user);

      // g1 has the bot; g2 does not. New user is a member of both.
      cleanups.push(await installBotInGuild('g1', { guildName: 'Bot Guild' }));

      const discord = createFakeDiscordClient({
        'tok': [
          { id: 'g1', name: 'Bot Guild', icon: null, permissions: '0' },
          { id: 'g2', name: 'No-Bot Guild', icon: null, permissions: '0' },
        ],
      });

      await syncGuildMemberships(user.id, 'tok', discord);

      const db = getDb();
      const rows = await db
        .select()
        .from(userGuildMemberships)
        .where(eq(userGuildMemberships.userId, user.id));
      const g1 = rows.find(r => r.guildId === 'g1')!;
      const g2 = rows.find(r => r.guildId === 'g2')!;
      // Bot-installed guild: enrolled across all three consent axes.
      expect(g1.enrolled).toBe(true);
      expect(g1.appearInQueries).toBe(true);
      expect(g1.includeInRollups).toBe(true);
      // Non-bot guild: stays off (no point enrolling if features need the bot).
      expect(g2.enrolled).toBe(false);
      expect(g2.appearInQueries).toBe(false);
      expect(g2.includeInRollups).toBe(false);
    });

    it('preserves enrolled + bundle flags across re-syncs', async () => {
      const user = await createTestUser();
      fixtures.push(user);

      // User arrives pre-enrolled in g1 (simulating a previous login +
      // explicit enrollment action).
      cleanups.push(await createGuildMembership(user.id, 'g1', { enrolled: true, canManage: false }));

      const discord = createFakeDiscordClient({
        'tok': [
          { id: 'g1', name: 'Updated Name', icon: 'newicon', permissions: '0' },
        ],
      });

      await syncGuildMemberships(user.id, 'tok', discord);

      const db = getDb();
      const [row] = await db.select().from(userGuildMemberships).where(and(
        eq(userGuildMemberships.userId, user.id),
        eq(userGuildMemberships.guildId, 'g1'),
      )).limit(1);
      // Metadata updated...
      expect(row.guildName).toBe('Updated Name');
      expect(row.guildIcon).toBe('newicon');
      // ...but consent flags preserved.
      expect(row.enrolled).toBe(true);
      expect(row.includeInRollups).toBe(true);
      expect(row.appearInQueries).toBe(true);
    });
  });

  describe('prune behaviour', () => {
    it('removes rows for guilds no longer in the returned list', async () => {
      const user = await createTestUser();
      fixtures.push(user);

      // Seed two memberships; Discord only returns one on the re-sync.
      cleanups.push(await createGuildMembership(user.id, 'keep', { enrolled: true }));
      cleanups.push(await createGuildMembership(user.id, 'drop', { enrolled: true }));

      const discord = createFakeDiscordClient({
        'tok': [
          { id: 'keep', name: 'Keep', icon: null, permissions: '0' },
        ],
      });

      await syncGuildMemberships(user.id, 'tok', discord);

      const db = getDb();
      const rows = await db.select().from(userGuildMemberships).where(eq(userGuildMemberships.userId, user.id));
      expect(rows.map(r => r.guildId)).toEqual(['keep']);
    });

    it('wipes all rows when Discord returns an empty list (user left every server)', async () => {
      const user = await createTestUser();
      fixtures.push(user);

      cleanups.push(await createGuildMembership(user.id, 'g1'));
      cleanups.push(await createGuildMembership(user.id, 'g2'));

      const discord = createFakeDiscordClient({ 'tok': [] });
      await syncGuildMemberships(user.id, 'tok', discord);

      const db = getDb();
      const rows = await db.select().from(userGuildMemberships).where(eq(userGuildMemberships.userId, user.id));
      expect(rows).toHaveLength(0);
    });
  });

  describe('resilience', () => {
    it('swallows Discord errors and leaves existing state untouched', async () => {
      const user = await createTestUser();
      fixtures.push(user);

      cleanups.push(await createGuildMembership(user.id, 'keep-me', { enrolled: true }));

      const discord = {
        async getUserGuilds() {
          throw new Error('Discord is down');
        },
      };

      // Should not throw.
      await syncGuildMemberships(user.id, 'tok', discord);

      const db = getDb();
      const rows = await db.select().from(userGuildMemberships).where(eq(userGuildMemberships.userId, user.id));
      // Existing row untouched.
      expect(rows).toHaveLength(1);
      expect(rows[0].guildId).toBe('keep-me');
    });
  });
});
