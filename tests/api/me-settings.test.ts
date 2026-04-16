import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import settingsHandler from '../../api/me/settings.js';
import guildSettingsHandler from '../../api/me/guilds/[guildId].js';
import guildsListHandler from '../../api/me/guilds.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { userGuildMemberships, botInstalledGuilds, users } from '../../lib/schema.js';
import { and, eq } from 'drizzle-orm';

describeWithDb('Phase 4 account + guild settings', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const installedGuildIds: string[] = [];

  async function seedGuildMembership(userId: string, guildId: string, opts: {
    enrolled?: boolean;
    installed?: boolean;
  } = {}) {
    const db = getDb();
    if (opts.installed) {
      await db.insert(botInstalledGuilds).values({
        guildId,
        guildName: `Guild ${guildId}`,
        guildIcon: null,
      });
      installedGuildIds.push(guildId);
    }
    await db.insert(userGuildMemberships).values({
      id: `ugm-${userId}-${guildId}`,
      userId,
      guildId,
      guildName: `Guild ${guildId}`,
      guildIcon: null,
      canManage: false,
      enrolled: opts.enrolled ?? false,
      includeInRollups: opts.enrolled ?? false,
      appearInQueries: opts.enrolled ?? false,
    });
  }

  afterEach(async () => {
    const db = getDb();
    for (const f of fixtures) {
      await db.delete(userGuildMemberships).where(eq(userGuildMemberships.userId, f.id)).catch(() => {});
      await f.cleanup();
    }
    fixtures.length = 0;
    for (const guildId of installedGuildIds) {
      await db.delete(botInstalledGuilds).where(eq(botInstalledGuilds.guildId, guildId)).catch(() => {});
    }
    installedGuildIds.length = 0;
  });

  describe('GET /api/me/settings', () => {
    it('returns default settings for a fresh user', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);

      const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
      const res = mockResponse();
      await settingsHandler(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        profileVisibility: 'public',
        dmTradeProposals: true,
        dmMatchAlerts: false,
        dmMeetupReminders: false,
      });
    });

    it('rejects unauthenticated callers', async () => {
      const req = mockRequest({ method: 'GET' });
      const res = mockResponse();
      await settingsHandler(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('PUT /api/me/settings', () => {
    it('applies partial patches', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);

      const req = mockRequest({
        method: 'PUT',
        cookies: { swu_session: cookie },
        body: { profileVisibility: 'discord', dmMatchAlerts: true },
      });
      const res = mockResponse();
      await settingsHandler(req, res);

      expect(res._status).toBe(200);
      const db = getDb();
      const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      expect(row.profileVisibility).toBe('discord');
      expect(row.dmMatchAlerts).toBe(true);
      // Fields not in the patch stay at their defaults.
      expect(row.dmTradeProposals).toBe(true);
    });

    it('rejects unknown fields with a 400', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);

      const req = mockRequest({
        method: 'PUT',
        cookies: { swu_session: cookie },
        body: { profileVisibility: 'galaxy-far-far-away' },
      });
      const res = mockResponse();
      await settingsHandler(req, res);
      expect(res._status).toBe(400);
    });
  });

  describe('GET /api/me/guilds', () => {
    it('groups memberships by bot installation', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);

      await seedGuildMembership(user.id, `installed-${user.id}`, { installed: true });
      await seedGuildMembership(user.id, `elsewhere-${user.id}`);

      const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
      const res = mockResponse();
      await guildsListHandler(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { enrollable: Array<{ guildId: string }>; other: Array<{ guildId: string }> };
      expect(body.enrollable.some(g => g.guildId === `installed-${user.id}`)).toBe(true);
      expect(body.other.some(g => g.guildId === `elsewhere-${user.id}`)).toBe(true);
    });
  });

  describe('PUT /api/me/guilds/[guildId]', () => {
    it('enrolling flips the bundle on', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);
      const guildId = `enroll-${user.id}`;
      await seedGuildMembership(user.id, guildId, { installed: true });

      const req = mockRequest({
        method: 'PUT',
        cookies: { swu_session: cookie },
        query: { guildId },
        body: { enrolled: true },
      });
      const res = mockResponse();
      await guildSettingsHandler(req, res);

      expect(res._status).toBe(200);
      const db = getDb();
      const [row] = await db.select().from(userGuildMemberships).where(and(
        eq(userGuildMemberships.userId, user.id),
        eq(userGuildMemberships.guildId, guildId),
      )).limit(1);
      expect(row.enrolled).toBe(true);
      expect(row.includeInRollups).toBe(true);
      expect(row.appearInQueries).toBe(true);
    });

    it('disenrolling clears the bundle', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);
      const guildId = `disenroll-${user.id}`;
      await seedGuildMembership(user.id, guildId, { installed: true, enrolled: true });

      const req = mockRequest({
        method: 'PUT',
        cookies: { swu_session: cookie },
        query: { guildId },
        body: { enrolled: false },
      });
      const res = mockResponse();
      await guildSettingsHandler(req, res);

      expect(res._status).toBe(200);
      const db = getDb();
      const [row] = await db.select().from(userGuildMemberships).where(and(
        eq(userGuildMemberships.userId, user.id),
        eq(userGuildMemberships.guildId, guildId),
      )).limit(1);
      expect(row.enrolled).toBe(false);
      expect(row.includeInRollups).toBe(false);
      expect(row.appearInQueries).toBe(false);
    });

    it('404s on guilds where the bot is not installed', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);
      const guildId = `ghost-${user.id}`;
      await seedGuildMembership(user.id, guildId); // no installed flag

      const req = mockRequest({
        method: 'PUT',
        cookies: { swu_session: cookie },
        query: { guildId },
        body: { enrolled: true },
      });
      const res = mockResponse();
      await guildSettingsHandler(req, res);

      expect(res._status).toBe(404);
    });
  });
});

