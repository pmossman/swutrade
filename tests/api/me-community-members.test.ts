import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleCommunityMembers } from '../../api/me.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
  insertWant,
  insertAvailable,
  installBotInGuild,
  createGuildMembership,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { userGuildMemberships, users, wantsItems, availableItems } from '../../lib/schema.js';

/**
 * Covers the per-user directory view that powers CommunityView.
 * The consent model is strict — these tests pin each gate so a
 * regression on any axis (mutual enrollment, appearInQueries,
 * profileVisibility, wantsPublic, availablePublic) surfaces here.
 */
describeWithDb('GET /api/me/community-members', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const db = getDb();
    for (const f of fixtures) {
      await db.delete(userGuildMemberships).where(eq(userGuildMemberships.userId, f.id)).catch(() => {});
      await db.delete(wantsItems).where(eq(wantsItems.userId, f.id)).catch(() => {});
      await db.delete(availableItems).where(eq(availableItems.userId, f.id)).catch(() => {});
      await f.cleanup();
    }
    fixtures.length = 0;
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
  });

  async function makeViewer(opts: { appearInQueries?: boolean } = {}) {
    const user = await createTestUser({ wantsPublic: true });
    fixtures.push(user);
    return user;
  }

  async function makeMember(opts: {
    wantsPublic?: boolean;
    availablePublic?: boolean;
    profileVisibility?: 'public' | 'discord' | 'private';
  } = {}) {
    const user = await createTestUser({ wantsPublic: opts.wantsPublic ?? true });
    fixtures.push(user);
    if (opts.availablePublic !== undefined || opts.profileVisibility !== undefined) {
      const db = getDb();
      await db.update(users)
        .set({
          availablePublic: opts.availablePublic ?? false,
          profileVisibility: opts.profileVisibility ?? 'discord',
        })
        .where(eq(users.id, user.id));
    }
    return user;
  }

  it('returns mutually-enrolled members with wants + available + overlap data', async () => {
    const viewer = await makeViewer();
    const other = await makeMember({ wantsPublic: true, availablePublic: true });

    const guildId = `dir-hp-${Date.now()}`;
    cleanups.push(await installBotInGuild(guildId, { guildName: 'Test Lounge' }));
    cleanups.push(await createGuildMembership(viewer.id, guildId, {
      enrolled: true,
      appearInQueries: true,
      guildName: 'Test Lounge',
    }));
    cleanups.push(await createGuildMembership(other.id, guildId, {
      enrolled: true,
      appearInQueries: true,
      guildName: 'Test Lounge',
    }));

    await insertWant(other.id, 'SOR_001_Luke');
    await insertWant(other.id, 'SOR_002_Vader');
    await insertAvailable(other.id, 'SOR_003_Leia_std');

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleCommunityMembers(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { members: Array<{
      userId: string; handle: string;
      mutualGuildNames: string[];
      wantFamilyIds: string[];
      availableProductIds: string[];
      wantsTotal: number; availableTotal: number;
    }> };
    expect(body.members).toHaveLength(1);
    const m = body.members[0];
    expect(m.userId).toBe(other.id);
    expect(m.mutualGuildNames).toEqual(['Test Lounge']);
    expect(m.wantFamilyIds.sort()).toEqual(['SOR_001_Luke', 'SOR_002_Vader']);
    expect(m.availableProductIds).toEqual(['SOR_003_Leia_std']);
    expect(m.wantsTotal).toBe(2);
    expect(m.availableTotal).toBe(1);
  });

  it('omits the viewer from their own directory', async () => {
    const viewer = await makeViewer();
    const other = await makeMember();

    const guildId = `dir-self-${Date.now()}`;
    cleanups.push(await installBotInGuild(guildId));
    cleanups.push(await createGuildMembership(viewer.id, guildId, { enrolled: true, appearInQueries: true }));
    cleanups.push(await createGuildMembership(other.id, guildId, { enrolled: true, appearInQueries: true }));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleCommunityMembers(req, res);

    const body = res._json as { members: Array<{ userId: string }> };
    const ids = body.members.map(m => m.userId);
    expect(ids).not.toContain(viewer.id);
    expect(ids).toContain(other.id);
  });

  it('omits members whose appearInQueries is off (they stay out of who-has queries)', async () => {
    const viewer = await makeViewer();
    const queryable = await makeMember();
    const lurker = await makeMember();

    const guildId = `dir-lurker-${Date.now()}`;
    cleanups.push(await installBotInGuild(guildId));
    cleanups.push(await createGuildMembership(viewer.id, guildId, { enrolled: true, appearInQueries: true }));
    cleanups.push(await createGuildMembership(queryable.id, guildId, { enrolled: true, appearInQueries: true }));
    cleanups.push(await createGuildMembership(lurker.id, guildId, { enrolled: true, appearInQueries: false }));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleCommunityMembers(req, res);

    const body = res._json as { members: Array<{ userId: string }> };
    const ids = body.members.map(m => m.userId);
    expect(ids).toContain(queryable.id);
    expect(ids).not.toContain(lurker.id);
  });

  it('omits members with profile=private even if they are query-visible', async () => {
    const viewer = await makeViewer();
    const visible = await makeMember({ profileVisibility: 'discord' });
    const hidden = await makeMember({ profileVisibility: 'private' });

    const guildId = `dir-private-${Date.now()}`;
    cleanups.push(await installBotInGuild(guildId));
    cleanups.push(await createGuildMembership(viewer.id, guildId, { enrolled: true, appearInQueries: true }));
    cleanups.push(await createGuildMembership(visible.id, guildId, { enrolled: true, appearInQueries: true }));
    cleanups.push(await createGuildMembership(hidden.id, guildId, { enrolled: true, appearInQueries: true }));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleCommunityMembers(req, res);

    const body = res._json as { members: Array<{ userId: string }> };
    const ids = body.members.map(m => m.userId);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(hidden.id);
  });

  it('respects wantsPublic/availablePublic — totals still show, contents stay empty', async () => {
    const viewer = await makeViewer();
    const mixed = await makeMember({ wantsPublic: true, availablePublic: false });

    const guildId = `dir-mixed-${Date.now()}`;
    cleanups.push(await installBotInGuild(guildId));
    cleanups.push(await createGuildMembership(viewer.id, guildId, { enrolled: true, appearInQueries: true }));
    cleanups.push(await createGuildMembership(mixed.id, guildId, { enrolled: true, appearInQueries: true }));

    await insertWant(mixed.id, 'family-1');
    await insertWant(mixed.id, 'family-2');
    await insertAvailable(mixed.id, 'product-1');
    await insertAvailable(mixed.id, 'product-2');
    await insertAvailable(mixed.id, 'product-3');

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleCommunityMembers(req, res);

    const body = res._json as { members: Array<{
      userId: string;
      wantsPublic: boolean; availablePublic: boolean;
      wantFamilyIds: string[]; availableProductIds: string[];
      wantsTotal: number; availableTotal: number;
    }> };
    const m = body.members.find(x => x.userId === mixed.id);
    expect(m).toBeTruthy();
    expect(m!.wantsPublic).toBe(true);
    expect(m!.availablePublic).toBe(false);
    // Contents: wants populated, available empty (private).
    expect(m!.wantFamilyIds.sort()).toEqual(['family-1', 'family-2']);
    expect(m!.availableProductIds).toEqual([]);
    // Totals: both populated — count isn't leakage of WHICH cards.
    expect(m!.wantsTotal).toBe(2);
    expect(m!.availableTotal).toBe(3);
  });

  it('no cross-guild leak — member in a guild you are not in stays hidden', async () => {
    const viewer = await makeViewer();
    const stranger = await makeMember();

    const yourGuild = `dir-yours-${Date.now()}`;
    const theirGuild = `dir-theirs-${Date.now()}`;
    cleanups.push(await installBotInGuild(yourGuild));
    cleanups.push(await installBotInGuild(theirGuild));
    cleanups.push(await createGuildMembership(viewer.id, yourGuild, { enrolled: true, appearInQueries: true }));
    cleanups.push(await createGuildMembership(stranger.id, theirGuild, { enrolled: true, appearInQueries: true }));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleCommunityMembers(req, res);

    const body = res._json as { members: Array<{ userId: string }> };
    expect(body.members.map(m => m.userId)).not.toContain(stranger.id);
  });

  it('viewer without enrolled+queryable guilds gets an empty list (no accidental public browse)', async () => {
    const viewer = await makeViewer();
    const other = await makeMember();

    const guildId = `dir-viewer-lurk-${Date.now()}`;
    cleanups.push(await installBotInGuild(guildId));
    // Viewer is enrolled but has appearInQueries=false — symmetric
    // consent rule says they can't see the directory either.
    cleanups.push(await createGuildMembership(viewer.id, guildId, { enrolled: true, appearInQueries: false }));
    cleanups.push(await createGuildMembership(other.id, guildId, { enrolled: true, appearInQueries: true }));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleCommunityMembers(req, res);

    const body = res._json as { members: unknown[] };
    expect(body.members).toEqual([]);
  });

  it('deduplicates guild names when a member shares multiple guilds with the viewer', async () => {
    const viewer = await makeViewer();
    const other = await makeMember();

    const g1 = `dir-multi-a-${Date.now()}`;
    const g2 = `dir-multi-b-${Date.now()}`;
    cleanups.push(await installBotInGuild(g1, { guildName: 'Rebel Alliance' }));
    cleanups.push(await installBotInGuild(g2, { guildName: 'Cloud City' }));
    cleanups.push(await createGuildMembership(viewer.id, g1, { enrolled: true, appearInQueries: true, guildName: 'Rebel Alliance' }));
    cleanups.push(await createGuildMembership(viewer.id, g2, { enrolled: true, appearInQueries: true, guildName: 'Cloud City' }));
    cleanups.push(await createGuildMembership(other.id, g1, { enrolled: true, appearInQueries: true, guildName: 'Rebel Alliance' }));
    cleanups.push(await createGuildMembership(other.id, g2, { enrolled: true, appearInQueries: true, guildName: 'Cloud City' }));

    const cookie = await sealTestCookie(viewer.id);
    const req = mockRequest({ method: 'GET', cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handleCommunityMembers(req, res);

    const body = res._json as { members: Array<{ userId: string; mutualGuildNames: string[] }> };
    const m = body.members.find(x => x.userId === other.id);
    expect(m!.mutualGuildNames.sort()).toEqual(['Cloud City', 'Rebel Alliance']);
  });
});
