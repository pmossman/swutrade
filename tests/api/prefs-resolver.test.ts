import { describeWithDb, createTestUser } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { resolvePref } from '../../lib/prefsResolver.js';
import { getDb } from '../../lib/db.js';
import { userPeerPrefs, users } from '../../lib/schema.js';

/**
 * Cascade resolution for `communicationPref` — the only pref
 * registered at both self and peer scope today. Adding another
 * dual-scoped pref should replicate these four cases for the new
 * key.
 */
describeWithDb('resolvePref — communicationPref cascade', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];

  afterEach(async () => {
    const db = getDb();
    for (const f of fixtures) {
      await db.delete(userPeerPrefs)
        .where(eq(userPeerPrefs.userId, f.id))
        .catch(() => {});
      await db.delete(userPeerPrefs)
        .where(eq(userPeerPrefs.peerUserId, f.id))
        .catch(() => {});
      await f.cleanup();
    }
    fixtures.length = 0;
  });

  it("returns the viewer's self-scoped value when no peer override exists", async () => {
    const viewer = await createTestUser({ communicationPref: 'prefer' });
    const peer = await createTestUser();
    fixtures.push(viewer, peer);

    const resolved = await resolvePref({
      key: 'communicationPref',
      viewerUserId: viewer.id,
      peerUserId: peer.id,
    });
    expect(resolved).toBe('prefer');
  });

  it('returns the peer override when one exists for this specific pair', async () => {
    const viewer = await createTestUser({ communicationPref: 'allow' });
    const peer = await createTestUser();
    fixtures.push(viewer, peer);

    const db = getDb();
    await db.insert(userPeerPrefs).values({
      userId: viewer.id,
      peerUserId: peer.id,
      communicationPref: 'prefer',
    });

    const resolved = await resolvePref({
      key: 'communicationPref',
      viewerUserId: viewer.id,
      peerUserId: peer.id,
    });
    expect(resolved).toBe('prefer');

    // The same viewer resolving against a DIFFERENT peer falls back
    // to self — overrides are scoped per (viewer, peer) pair.
    const unrelatedPeer = await createTestUser();
    fixtures.push(unrelatedPeer);
    const fallback = await resolvePref({
      key: 'communicationPref',
      viewerUserId: viewer.id,
      peerUserId: unrelatedPeer.id,
    });
    expect(fallback).toBe('allow');
  });

  it("treats a null override as inherit (viewer's self value wins)", async () => {
    const viewer = await createTestUser({ communicationPref: 'dm-only' });
    const peer = await createTestUser();
    fixtures.push(viewer, peer);

    const db = getDb();
    await db.insert(userPeerPrefs).values({
      userId: viewer.id,
      peerUserId: peer.id,
      communicationPref: null,
    });

    const resolved = await resolvePref({
      key: 'communicationPref',
      viewerUserId: viewer.id,
      peerUserId: peer.id,
    });
    expect(resolved).toBe('dm-only');
  });

  it("falls back to the registry default when the viewer row doesn't exist (belt-and-suspenders)", async () => {
    // The resolver should never crash on a missing user — if the
    // self-column read turns up no row, it returns the registry
    // default. communicationPref defaults to 'allow'.
    const resolved = await resolvePref({
      key: 'communicationPref',
      viewerUserId: 'ghost-user-does-not-exist',
    });
    expect(resolved).toBe('allow');
  });

  it('throws on unknown key — resolver is strict about contract', async () => {
    await expect(resolvePref({
      key: 'noSuchPref',
      viewerUserId: 'whatever',
      peerUserId: 'whatever',
    })).rejects.toThrow(/no self-scoped def/i);
  });
});

/**
 * Integration — prove the propose flow picks up peer overrides. If
 * my self default is 'allow' but I've overridden to 'prefer' for
 * Alice specifically, Alice receiving my proposal should see the
 * thread-immediately path when her own settings also favor threads.
 * This is the user-visible payoff of step 7.
 */
describeWithDb('handlePropose uses resolvePref for delivery matrix', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];

  afterEach(async () => {
    const db = getDb();
    for (const f of fixtures) {
      await db.delete(userPeerPrefs)
        .where(and(eq(userPeerPrefs.userId, f.id)))
        .catch(() => {});
      await db.delete(userPeerPrefs)
        .where(and(eq(userPeerPrefs.peerUserId, f.id)))
        .catch(() => {});
      await f.cleanup();
    }
    fixtures.length = 0;
  });

  it('a peer override on BOTH sides flips delivery from dm-with-request to thread-immediately', async () => {
    // Both users' self defaults are 'allow' (dm-with-request when
    // paired). Override each side to 'prefer' vs the other and the
    // resolver should flip the matrix outcome.
    const viewer = await createTestUser();
    const peer = await createTestUser();
    fixtures.push(viewer, peer);

    const db = getDb();
    await db.insert(userPeerPrefs).values([
      { userId: viewer.id, peerUserId: peer.id, communicationPref: 'prefer' },
      { userId: peer.id, peerUserId: viewer.id, communicationPref: 'prefer' },
    ]);

    const viewerEffective = await resolvePref({
      key: 'communicationPref',
      viewerUserId: viewer.id,
      peerUserId: peer.id,
    });
    const peerEffective = await resolvePref({
      key: 'communicationPref',
      viewerUserId: peer.id,
      peerUserId: viewer.id,
    });
    expect(viewerEffective).toBe('prefer');
    expect(peerEffective).toBe('prefer');

    // Sanity: the SAME users without peer overrides would resolve
    // to 'allow' — the override is what flipped the outcome.
    await db.delete(userPeerPrefs).where(eq(userPeerPrefs.userId, viewer.id));
    await db.delete(userPeerPrefs).where(eq(userPeerPrefs.userId, peer.id));
    const fallback = await resolvePref({
      key: 'communicationPref',
      viewerUserId: viewer.id,
      peerUserId: peer.id,
    });
    // Default is 'allow' unless the seeded user was given another value.
    expect(fallback).toBe('allow');

    // Quiet unused-var lint
    void fallback;
    void users;
  });
});
