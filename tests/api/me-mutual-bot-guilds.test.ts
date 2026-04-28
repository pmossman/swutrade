import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { handleMutualBotGuilds } from '../../api/me.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
  createMutualGuildMembership,
} from './helpers.js';

/**
 * GET /api/me/mutual-bot-guilds — exposes the (viewer, target) pair's
 * intersection of bot-installed guilds. Server-core resolver gets the
 * same numbers; this endpoint just renders them for the picker UI.
 */
describeWithDb('GET /api/me/mutual-bot-guilds', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('401 without auth', async () => {
    const target = await createTestUser();
    fixtures.push(target);
    const req = mockRequest({ method: 'GET', query: { with: target.handle } });
    const res = mockResponse();
    await handleMutualBotGuilds(req, res);
    expect(res._status).toBe(401);
  });

  it('405 on non-GET', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'POST', cookies: { swu_session: cookie }, body: {} });
    const res = mockResponse();
    await handleMutualBotGuilds(req, res);
    expect(res._status).toBe(405);
  });

  it('400 when ?with= is missing', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleMutualBotGuilds(req, res);
    expect(res._status).toBe(400);
  });

  it('returns [] for an unknown target handle (no existence leak)', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { with: 'no-such-user' },
    });
    const res = mockResponse();
    await handleMutualBotGuilds(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual([]);
  });

  it('returns [] when the target is the viewer (self-trade is blocked anyway)', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { with: viewer.handle },
    });
    const res = mockResponse();
    await handleMutualBotGuilds(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual([]);
  });

  it('returns [] when no mutual bot-installed guild exists', async () => {
    const viewer = await createTestUser();
    const target = await createTestUser();
    fixtures.push(viewer, target);
    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { with: target.handle },
    });
    const res = mockResponse();
    await handleMutualBotGuilds(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual([]);
  });

  it('returns the intersection ordered by the cascade — first entry isDefault=true', async () => {
    const viewer = await createTestUser();
    const target = await createTestUser();
    fixtures.push(viewer, target);

    cleanups.push(await createMutualGuildMembership(viewer.id, target.id, 'g-A', {
      tradesChannelId: 'ch-A',
    }));
    cleanups.push(await createMutualGuildMembership(viewer.id, target.id, 'g-B', {
      tradesChannelId: 'ch-B',
    }));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({
      method: 'GET',
      cookies: { swu_session: cookie },
      query: { with: target.handle },
    });
    const res = mockResponse();
    await handleMutualBotGuilds(req, res);
    expect(res._status).toBe(200);

    const body = res._json as Array<{ guildId: string; isDefault: boolean }>;
    expect(body).toHaveLength(2);
    expect(body.filter(g => g.isDefault)).toHaveLength(1);
    expect(body[0].isDefault).toBe(true);
    // Channel id is intentionally omitted from the public response —
    // the picker only needs guild metadata, not the internal channel
    // id (server resolves that fresh at propose-time).
    expect((body[0] as Record<string, unknown>).tradesChannelId).toBeUndefined();
  });
});
