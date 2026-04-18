import { and, eq } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { getDb } from './db.js';
import { users, userPeerPrefs } from './schema.js';
import {
  getPrefDefinition,
  type PrefValue,
} from './prefsRegistry.js';

/**
 * Resolve a pref's effective value for a (viewer, peer?) pair.
 *
 * Cascade:
 *   1. Peer override — if a peer-scoped def exists AND the caller
 *      supplied `peerUserId` AND a non-null override row exists for
 *      that pair, return the override.
 *   2. Viewer's self-scoped value — read from the `users` column
 *      matching the self-scoped def's `column`.
 *   3. Registry default — the self-scoped def's `default` literal.
 *
 * Always goes through the self-scoped def — every key MUST be
 * registered at self scope (a peer-only registration has no
 * baseline to inherit from). Unknown keys throw; callers should
 * validate key names at the API boundary, not rely on this for
 * fallback behavior.
 *
 * This keeps downstream consumers — threadConsent.ts's decision
 * matrix, notification gating, etc. — pure: they receive a single
 * resolved value and never touch storage.
 */
export async function resolvePref(opts: {
  key: string;
  viewerUserId: string;
  peerUserId?: string;
}): Promise<PrefValue> {
  const selfDef = getPrefDefinition(opts.key, 'self');
  if (!selfDef) {
    throw new Error(`resolvePref: no self-scoped def registered for key "${opts.key}"`);
  }

  const db = getDb();

  // Step 1: peer override.
  const peerDef = getPrefDefinition(opts.key, 'peer');
  if (peerDef && opts.peerUserId) {
    const peerCols = userPeerPrefs as unknown as Record<string, AnyPgColumn>;
    const peerColumn = peerCols[peerDef.column];
    if (peerColumn) {
      const [row] = await db
        .select({ value: peerColumn })
        .from(userPeerPrefs)
        .where(and(
          eq(userPeerPrefs.userId, opts.viewerUserId),
          eq(userPeerPrefs.peerUserId, opts.peerUserId),
        ))
        .limit(1);
      if (row?.value !== undefined && row.value !== null) {
        return row.value as PrefValue;
      }
    }
  }

  // Step 2: viewer's self-scoped column.
  const selfCols = users as unknown as Record<string, AnyPgColumn>;
  const selfColumn = selfCols[selfDef.column];
  if (selfColumn) {
    const [row] = await db
      .select({ value: selfColumn })
      .from(users)
      .where(eq(users.id, opts.viewerUserId))
      .limit(1);
    if (row?.value !== undefined && row.value !== null) {
      return row.value as PrefValue;
    }
  }

  // Step 3: registry default.
  return selfDef.default;
}
