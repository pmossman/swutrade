import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleCommunityActivity } from '../../api/me.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
  installBotInGuild,
  createGuildMembership,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { communityEvents, users, userGuildMemberships } from '../../lib/schema.js';
import { recordEvent } from '../../lib/communityEvents.js';

/**
 * Covers the activity-feed endpoint on the Community Overview tab.
 * Gates: viewer must be enrolled + queryable; actor privacy pref
 * suppresses events on read; events are ordered newest-first.
 */
describeWithDb('GET /api/me/community-activity', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const cleanups: Array<() => Promise<void>> = [];
  const touchedGuildIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const gid of touchedGuildIds) {
      await db.delete(communityEvents).where(eq(communityEvents.guildId, gid)).catch(() => {});
    }
    touchedGuildIds.length = 0;
    for (const f of fixtures) {
      await db.delete(userGuildMemberships).where(eq(userGuildMemberships.userId, f.id)).catch(() => {});
      await f.cleanup();
    }
    fixtures.length = 0;
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
  });

  it('returns the guild feed newest-first when viewer is enrolled + queryable', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const actor = await createTestUser();
    fixtures.push(actor);

    const guildId = `feed-basic-${Date.now()}`;
    touchedGuildIds.push(guildId);
    cleanups.push(await installBotInGuild(guildId, { guildName: 'Feed Hall' }));
    cleanups.push(await createGuildMembership(viewer.id, guildId, {
      enrolled: true,
      appearInQueries: true,
    }));

    const db = getDb();
    await recordEvent(db, { guildId, actorUserId: actor.id, type: 'member_joined' });
    await new Promise(r => setTimeout(r, 10));
    await recordEvent(db, {
      guildId,
      actorUserId: actor.id,
      type: 'trade_accepted',
      payload: { proposalId: 'p1', counterpartUserId: viewer.id },
    });

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { guildId },
    });
    const res = mockResponse();
    await handleCommunityActivity(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { events: Array<{ type: string; actor: { id: string } | null }> };
    expect(body.events).toHaveLength(2);
    expect(body.events[0].type).toBe('trade_accepted');
    expect(body.events[1].type).toBe('member_joined');
    expect(body.events[0].actor?.id).toBe(actor.id);
  });

  it('403s when the viewer is not enrolled in the guild', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);

    const guildId = `feed-unenrolled-${Date.now()}`;
    touchedGuildIds.push(guildId);
    cleanups.push(await installBotInGuild(guildId));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { guildId },
    });
    const res = mockResponse();
    await handleCommunityActivity(req, res);

    expect(res._status).toBe(403);
  });

  it('suppresses events from actors who have shareActivityPublicly=false', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const hidden = await createTestUser();
    fixtures.push(hidden);

    const db = getDb();
    await db.update(users)
      .set({ shareActivityPublicly: false })
      .where(eq(users.id, hidden.id));

    const guildId = `feed-hidden-${Date.now()}`;
    touchedGuildIds.push(guildId);
    cleanups.push(await installBotInGuild(guildId));
    cleanups.push(await createGuildMembership(viewer.id, guildId, {
      enrolled: true,
      appearInQueries: true,
    }));

    await recordEvent(db, { guildId, actorUserId: hidden.id, type: 'member_joined' });

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { guildId },
    });
    const res = mockResponse();
    await handleCommunityActivity(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { events: unknown[] };
    expect(body.events).toHaveLength(0);
  });

  it('400s when guildId is missing', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie }, query: {} });
    const res = mockResponse();
    await handleCommunityActivity(req, res);
    expect(res._status).toBe(400);
  });
});
