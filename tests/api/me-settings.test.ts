import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import {
  handlePrefs as prefsHandler,
  handleSettings as settingsHandler,
  handleGuildsList as guildsListHandler,
  handleGuildPut as guildSettingsHandler,
  handleCommunity as communityHandler,
} from '../../api/me.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
  insertWant,
  insertAvailable,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { userGuildMemberships, botInstalledGuilds, users, wantsItems, availableItems } from '../../lib/schema.js';
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

  describe('GET /api/me/prefs', () => {
    it('returns every self-scoped registered pref keyed by its `key`', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);

      const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
      const res = mockResponse();
      await prefsHandler(req, res);

      expect(res._status).toBe(200);
      // Every registered self-scoped pref should surface. Adding a
      // new pref to the registry and forgetting to include it here
      // means this test fails — that's the intent.
      expect(res._json).toMatchObject({
        profileVisibility: 'discord',
        communicationPref: 'allow',
        dmTradeProposals: true,
        dmMatchAlerts: false,
        dmMeetupReminders: false,
      });
    });
  });

  describe('PUT /api/me/prefs', () => {
    it('applies partial patches across multiple self-scoped prefs', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);

      const req = mockRequest({
        method: 'PUT',
        cookies: { swu_session: cookie },
        body: { communicationPref: 'prefer', dmMatchAlerts: true },
      });
      const res = mockResponse();
      await prefsHandler(req, res);

      expect(res._status).toBe(200);
      const db = getDb();
      const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      expect(row.communicationPref).toBe('prefer');
      expect(row.dmMatchAlerts).toBe(true);
      // Untouched fields stay at their defaults.
      expect(row.profileVisibility).toBe('discord');
      expect(row.dmTradeProposals).toBe(true);
    });

    it('400s on an unknown pref key with `key` in the response (no silent drop)', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);

      const req = mockRequest({
        method: 'PUT',
        cookies: { swu_session: cookie },
        body: { notAPref: true },
      });
      const res = mockResponse();
      await prefsHandler(req, res);

      expect(res._status).toBe(400);
      expect(res._json).toMatchObject({ error: 'Unknown pref', key: 'notAPref' });
    });

    it('400s on an invalid enum value with `reason` explaining the allowed set', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);

      const req = mockRequest({
        method: 'PUT',
        cookies: { swu_session: cookie },
        body: { communicationPref: 'threadify' },
      });
      const res = mockResponse();
      await prefsHandler(req, res);

      expect(res._status).toBe(400);
      expect(res._json).toMatchObject({
        error: 'Invalid value',
        key: 'communicationPref',
      });
      expect((res._json as { reason?: string }).reason).toMatch(/expected one of/);
    });

    it('400s on a type mismatch (boolean pref receiving a string)', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);

      const req = mockRequest({
        method: 'PUT',
        cookies: { swu_session: cookie },
        body: { dmTradeProposals: 'yes' },
      });
      const res = mockResponse();
      await prefsHandler(req, res);

      expect(res._status).toBe(400);
      expect(res._json).toMatchObject({ error: 'Invalid value', key: 'dmTradeProposals' });
    });

    it('400s on an empty body (no-op patches are client bugs)', async () => {
      const user = await createTestUser();
      fixtures.push(user);
      const cookie = await sealTestCookie(user.id);

      const req = mockRequest({
        method: 'PUT',
        cookies: { swu_session: cookie },
        body: {},
      });
      const res = mockResponse();
      await prefsHandler(req, res);

      expect(res._status).toBe(400);
    });
  });

  // Retained: /api/me/settings is a transitional alias that routes
  // to the same registry-driven handler. These tests prove stale
  // clients pointing at the old URL continue to work until we cut
  // the alias in a follow-up slice.
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
        profileVisibility: 'discord',
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

  describe('GET /api/me/community', () => {
    it('returns empty rollup when viewer has no enrolled guilds', async () => {
      const viewer = await createTestUser();
      fixtures.push(viewer);
      const cookie = await sealTestCookie(viewer.id);

      const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
      const res = mockResponse();
      await communityHandler(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ wantFamilyIds: [], availableProductIds: [] });
    });

    it('aggregates wants + available across mutually-enrolled guild members', async () => {
      // Viewer + two peers, all enrolled+rollup-on in the same guild.
      // peerA opts their available list public; peerB is private (the
      // default) so the endpoint should include peerA's products but
      // not peerB's.
      const viewer = await createTestUser();
      const peerA = await createTestUser({ availablePublic: true });
      const peerB = await createTestUser();
      fixtures.push(viewer, peerA, peerB);
      const cookie = await sealTestCookie(viewer.id);

      const guildId = `rollup-guild-${viewer.id}`;
      await seedGuildMembership(viewer.id, guildId, { enrolled: true, installed: true });
      await seedGuildMembership(peerA.id, guildId, { enrolled: true });
      await seedGuildMembership(peerB.id, guildId, { enrolled: true });

      await insertWant(peerA.id, 'set::wanted-by-peer-a');
      await insertWant(peerB.id, 'set::wanted-by-peer-b');
      await insertAvailable(peerA.id, 'product-peer-a', 1);
      await insertAvailable(peerB.id, 'product-peer-b', 1);
      // Viewer's own items should NOT appear in the rollup.
      await insertWant(viewer.id, 'set::viewer-own-want');
      await insertAvailable(viewer.id, 'product-viewer-own', 1);

      // peerB is private — won't show up in available rollup (and
      // stays private under the createTestUser default, so no update
      // needed).

      const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
      const res = mockResponse();
      await communityHandler(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { wantFamilyIds: string[]; availableProductIds: string[] };
      expect(body.wantFamilyIds).toContain('set::wanted-by-peer-a');
      expect(body.wantFamilyIds).toContain('set::wanted-by-peer-b');
      expect(body.wantFamilyIds).not.toContain('set::viewer-own-want');
      expect(body.availableProductIds).toContain('product-peer-a');
      expect(body.availableProductIds).not.toContain('product-peer-b'); // private
      expect(body.availableProductIds).not.toContain('product-viewer-own');
    });

    it('omits users whose rollup consent is off even if enrolled', async () => {
      const viewer = await createTestUser();
      const peer = await createTestUser();
      fixtures.push(viewer, peer);
      const cookie = await sealTestCookie(viewer.id);

      const guildId = `consent-guild-${viewer.id}`;
      await seedGuildMembership(viewer.id, guildId, { enrolled: true, installed: true });
      // Peer is enrolled but explicitly opted out of rollups.
      await seedGuildMembership(peer.id, guildId, { enrolled: true });
      const db = getDb();
      await db.update(userGuildMemberships)
        .set({ includeInRollups: false })
        .where(and(
          eq(userGuildMemberships.userId, peer.id),
          eq(userGuildMemberships.guildId, guildId),
        ));
      await insertWant(peer.id, 'set::not-rolled-up');

      const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
      const res = mockResponse();
      await communityHandler(req, res);

      const body = res._json as { wantFamilyIds: string[] };
      expect(body.wantFamilyIds).not.toContain('set::not-rolled-up');
    });

    it('only considers mutual guilds (no cross-server leak)', async () => {
      const viewer = await createTestUser();
      const strangerInOtherGuild = await createTestUser();
      fixtures.push(viewer, strangerInOtherGuild);
      const cookie = await sealTestCookie(viewer.id);

      const viewerGuild = `viewer-guild-${viewer.id}`;
      const strangerGuild = `stranger-guild-${viewer.id}`;
      await seedGuildMembership(viewer.id, viewerGuild, { enrolled: true, installed: true });
      await seedGuildMembership(strangerInOtherGuild.id, strangerGuild, { enrolled: true, installed: true });
      await insertWant(strangerInOtherGuild.id, 'set::cross-server-leak');

      const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
      const res = mockResponse();
      await communityHandler(req, res);

      const body = res._json as { wantFamilyIds: string[] };
      expect(body.wantFamilyIds).not.toContain('set::cross-server-leak');
    });

    it('rejects unauthenticated callers', async () => {
      const req = mockRequest({ method: 'GET' });
      const res = mockResponse();
      await communityHandler(req, res);
      expect(res._status).toBe(401);
    });
  });
});

