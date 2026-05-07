import { describeWithDb, createTestUser } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { resolvePref } from '../../lib/prefsResolver.js';
import { getDb } from '../../lib/db.js';
import { users } from '../../lib/schema.js';
import { eq } from 'drizzle-orm';

/**
 * resolvePref — post-prefs-hygiene-pass behavior.
 *
 * Peer scope was retired with `communicationPref`; the resolver now
 * only reads the self-scoped column with a registry-default fallback.
 * The cascade tests that were here are deleted along with the table.
 */
describeWithDb('resolvePref — self-only resolution', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];

  afterEach(async () => {
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('returns the user-set value when the column is non-null', async () => {
    const user = await createTestUser();
    fixtures.push(user);

    const db = getDb();
    await db.update(users).set({ dmSessionInvited: false }).where(eq(users.id, user.id));

    const resolved = await resolvePref({
      key: 'dmSessionInvited',
      viewerUserId: user.id,
    });
    expect(resolved).toBe(false);
  });

  it('falls back to the registry default when the column is unset (default true)', async () => {
    const user = await createTestUser();
    fixtures.push(user);

    const resolved = await resolvePref({
      key: 'dmSessionInvited',
      viewerUserId: user.id,
    });
    expect(resolved).toBe(true);
  });

  it("returns the registry default when the viewer row doesn't exist (belt-and-suspenders)", async () => {
    const resolved = await resolvePref({
      key: 'dmSessionInvited',
      viewerUserId: 'ghost-user-does-not-exist',
    });
    expect(resolved).toBe(true);
  });

  it('throws on unknown key — resolver is strict about contract', async () => {
    await expect(resolvePref({
      key: 'noSuchPref',
      viewerUserId: 'whatever',
    })).rejects.toThrow(/no self-scoped def/i);
  });
});
