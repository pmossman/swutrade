import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleGuildsRefresh } from '../../api/me.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
  installBotInGuild,
  createFakeDiscordClient,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { userGuildMemberships } from '../../lib/schema.js';
import type { DiscordClient } from '../../lib/discordClient.js';

/**
 * Covers the server-side contract for `POST /api/me/guilds/refresh`.
 *
 * The UI flow: user lands on Settings, clicks "Refresh servers", we
 * re-hit Discord's `/users/@me/guilds` with the access token stored
 * in the session cookie, reconcile `user_guild_memberships`, return
 * the fresh list. These tests pin the auth/failure modes so a
 * regression in session handling (e.g., token not persisted, or
 * expiry check inverted) surfaces here instead of in manual Tier 3.
 */
describeWithDb('POST /api/me/guilds/refresh', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const db = getDb();
    for (const f of fixtures) {
      await db.delete(userGuildMemberships).where(eq(userGuildMemberships.userId, f.id)).catch(() => {});
      await f.cleanup();
    }
    fixtures.length = 0;
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
  });

  it('401s when unauthenticated (no session cookie)', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handleGuildsRefresh(req, res);
    expect(res._status).toBe(401);
  });

  it('405s on GET (POST-only)', async () => {
    const user = await createTestUser();
    fixtures.push(user);
    const cookie = await sealTestCookie(user.id, {
      discordAccessToken: 'tok',
      discordAccessTokenExpiresAt: Date.now() + 60_000,
    });

    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleGuildsRefresh(req, res);
    expect(res._status).toBe(405);
  });

  it('409 discord-token-unavailable when session has no access token', async () => {
    const user = await createTestUser();
    fixtures.push(user);
    const cookie = await sealTestCookie(user.id);

    const req = mockRequest({ method: 'POST', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleGuildsRefresh(req, res);
    expect(res._status).toBe(409);
    expect(res._json).toMatchObject({ error: 'discord-token-unavailable' });
  });

  it('409 discord-token-unavailable when access token has expired', async () => {
    const user = await createTestUser();
    fixtures.push(user);
    const cookie = await sealTestCookie(user.id, {
      discordAccessToken: 'expired-tok',
      discordAccessTokenExpiresAt: Date.now() - 60_000,
    });

    const req = mockRequest({ method: 'POST', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleGuildsRefresh(req, res);
    expect(res._status).toBe(409);
    expect(res._json).toMatchObject({ error: 'discord-token-unavailable' });
  });

  it('409 when Discord returns 401 (revoked token — surfaces same re-auth prompt)', async () => {
    const user = await createTestUser();
    fixtures.push(user);
    const cookie = await sealTestCookie(user.id, {
      discordAccessToken: 'revoked-tok',
      discordAccessTokenExpiresAt: Date.now() + 60_000,
    });

    const brokenDiscord: DiscordClient = {
      async getUserGuilds() {
        throw new Error('Discord API returned 401 Unauthorized');
      },
    };

    const req = mockRequest({ method: 'POST', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleGuildsRefresh(req, res, brokenDiscord);
    expect(res._status).toBe(409);
    expect(res._json).toMatchObject({ error: 'discord-token-unavailable' });
  });

  it('reconciles the membership list and returns the fresh grouping', async () => {
    const user = await createTestUser();
    fixtures.push(user);

    // Pre-existing stale state: a guild the user has since left,
    // with enrollment on. We expect it to be pruned after refresh.
    const staleGuildId = `refresh-stale-${Date.now()}`;
    cleanups.push(await installBotInGuild(staleGuildId));
    const db = getDb();
    await db.insert(userGuildMemberships).values({
      id: `ugm-${user.id}-${staleGuildId}`,
      userId: user.id,
      guildId: staleGuildId,
      guildName: 'Old Server',
      guildIcon: null,
      canManage: false,
      enrolled: true,
      includeInRollups: true,
      appearInQueries: true,
    });

    // New guild Discord will now return — bot is installed there,
    // so it should come back under `enrollable` with enrolled=false
    // (the refresh preserves consent but we haven't enrolled in this
    // new guild yet).
    const freshGuildId = `refresh-fresh-${Date.now()}`;
    cleanups.push(await installBotInGuild(freshGuildId, { guildName: 'Fresh Server' }));

    // Another guild Discord returns that the bot ISN'T installed in
    // — should land in `other`.
    const otherGuildId = `refresh-other-${Date.now()}`;

    const fakeDiscord = createFakeDiscordClient({
      'valid-tok': [
        { id: freshGuildId, name: 'Fresh Server', icon: null, permissions: '0' },
        { id: otherGuildId, name: 'No-Bot Server', icon: null, permissions: '0' },
      ],
    });

    const cookie = await sealTestCookie(user.id, {
      discordAccessToken: 'valid-tok',
      discordAccessTokenExpiresAt: Date.now() + 60_000,
    });

    const req = mockRequest({ method: 'POST', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleGuildsRefresh(req, res, fakeDiscord);

    expect(res._status).toBe(200);
    const body = res._json as {
      enrollable: Array<{ guildId: string }>;
      other: Array<{ guildId: string }>;
    };
    const enrollableIds = body.enrollable.map(g => g.guildId);
    const otherIds = body.other.map(g => g.guildId);

    // Stale guild is gone — we pruned it from memberships.
    expect(enrollableIds).not.toContain(staleGuildId);
    // Fresh guild appears under enrollable (bot installed there).
    expect(enrollableIds).toContain(freshGuildId);
    // Other guild appears under `other` (bot not installed yet).
    expect(otherIds).toContain(otherGuildId);
  });
});
