import { describeWithDb } from './helpers.js';
import { it, expect, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { handleFavoriteDelete, handleFavorites } from '../../api/me.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';
import { getDb } from '../../lib/db.js';
import { userFavoritePartners, users } from '../../lib/schema.js';

/**
 * Covers the favorites (trading-partners) CRUD under /api/me/favorites.
 * Happy paths: GET returns the viewer's bookmarks ordered newest-first;
 * POST adds by handle (idempotent on repeat); DELETE removes by handle
 * (idempotent when absent). Boundary cases: self-favorite rejected,
 * ghost users rejected, 404 on unknown handle.
 */
describeWithDb('POST/GET/DELETE /api/me/favorites', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];

  afterEach(async () => {
    // Favorites cascade from user FKs, so the fixture cleanup alone
    // removes the rows — but we defensively wipe in case a test
    // leaves fixtures in place across rollbacks.
    const db = getDb();
    for (const f of fixtures) {
      await db
        .delete(userFavoritePartners)
        .where(eq(userFavoritePartners.userId, f.id))
        .catch(() => {});
    }
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('GET returns an empty list when the viewer has no favorites', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);

    const res = mockResponse();
    await handleFavorites(
      mockRequest({
        method: 'GET',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect((res._json as { favorites: unknown[] }).favorites).toEqual([]);
  });

  it('POST adds a favorite by handle; GET surfaces it', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const bob = await createTestUser();
    fixtures.push(bob);

    let res = mockResponse();
    await handleFavorites(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        body: { handle: bob.handle },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const added = (res._json as { favorite: { userId: string; handle: string } }).favorite;
    expect(added.userId).toBe(bob.id);
    expect(added.handle).toBe(bob.handle);

    res = mockResponse();
    await handleFavorites(
      mockRequest({
        method: 'GET',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const list = (res._json as { favorites: Array<{ userId: string }> }).favorites;
    expect(list.map(f => f.userId)).toEqual([bob.id]);
  });

  it('POST is idempotent — re-favoriting the same user is a no-op 200', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const bob = await createTestUser();
    fixtures.push(bob);

    for (let i = 0; i < 2; i++) {
      const res = mockResponse();
      await handleFavorites(
        mockRequest({
          method: 'POST',
          cookies: { swu_session: await sealTestCookie(viewer.id) },
          body: { handle: bob.handle },
        }),
        res,
      );
      expect(res._status).toBe(200);
    }

    const db = getDb();
    const rows = await db
      .select()
      .from(userFavoritePartners)
      .where(eq(userFavoritePartners.userId, viewer.id));
    expect(rows).toHaveLength(1);
  });

  it('POST rejects self-favorite with 400', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);

    const res = mockResponse();
    await handleFavorites(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        body: { handle: viewer.handle },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('POST 404s on unknown handle', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);

    const res = mockResponse();
    await handleFavorites(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        body: { handle: 'nonexistent-handle-xyz' },
      }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('POST 404s on ghost (anonymous) target — ghosts cannot be bookmarked', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const ghost = await createTestUser();
    fixtures.push(ghost);

    // Flip the ghost's isAnonymous flag directly — createTestUser
    // mints real users by default.
    const db = getDb();
    await db
      .update(users)
      .set({ isAnonymous: true })
      .where(eq(users.id, ghost.id));

    const res = mockResponse();
    await handleFavorites(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        body: { handle: ghost.handle },
      }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('DELETE removes a favorite by handle', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const bob = await createTestUser();
    fixtures.push(bob);

    // Seed directly via handleFavorites to exercise the full path.
    let res = mockResponse();
    await handleFavorites(
      mockRequest({
        method: 'POST',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        body: { handle: bob.handle },
      }),
      res,
    );
    expect(res._status).toBe(200);

    res = mockResponse();
    await handleFavoriteDelete(
      mockRequest({
        method: 'DELETE',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        query: { handle: bob.handle },
      }),
      res,
    );
    expect(res._status).toBe(204);

    const db = getDb();
    const rows = await db
      .select()
      .from(userFavoritePartners)
      .where(and(
        eq(userFavoritePartners.userId, viewer.id),
        eq(userFavoritePartners.partnerUserId, bob.id),
      ));
    expect(rows).toHaveLength(0);
  });

  it('DELETE is idempotent — removing a missing favorite returns 204', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const bob = await createTestUser();
    fixtures.push(bob);

    const res = mockResponse();
    await handleFavoriteDelete(
      mockRequest({
        method: 'DELETE',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        query: { handle: bob.handle },
      }),
      res,
    );
    expect(res._status).toBe(204);
  });

  it('DELETE 204s when the handle is unknown (desired end state already)', async () => {
    const viewer = await createTestUser();
    fixtures.push(viewer);

    const res = mockResponse();
    await handleFavoriteDelete(
      mockRequest({
        method: 'DELETE',
        cookies: { swu_session: await sealTestCookie(viewer.id) },
        query: { handle: 'nonexistent-handle-xyz' },
      }),
      res,
    );
    expect(res._status).toBe(204);
  });
});
