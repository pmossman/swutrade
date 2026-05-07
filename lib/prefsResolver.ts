import { eq } from 'drizzle-orm';
import { getDb } from './db.js';
import { users } from './schema.js';
import {
  getPrefDefinition,
  getUserPrefColumn,
  type PrefValue,
} from './prefsRegistry.js';

/**
 * Resolve a pref's effective value for a viewer.
 *
 * Cascade:
 *   1. Viewer's self-scoped value — read from the `users` column
 *      matching the def's `column`.
 *   2. Registry default — the def's `default` literal.
 *
 * Unknown keys throw; callers should validate key names at the API
 * boundary, not rely on this for fallback behavior.
 *
 * (Per-peer overrides existed historically when `communicationPref`
 * was a peer-scoped pref. With proposals retired in Phase C and
 * `communicationPref` dropped in the prefs hygiene pass, no
 * peer-scoped prefs remain. The `peerUserId` arg is preserved for
 * legacy callers that still pass it; the value is ignored.)
 */
export async function resolvePref(opts: {
  key: string;
  viewerUserId: string;
  /** @deprecated No peer-scoped prefs exist after the hygiene pass. */
  peerUserId?: string;
}): Promise<PrefValue> {
  const selfDef = getPrefDefinition(opts.key, 'self');
  if (!selfDef) {
    throw new Error(`resolvePref: no self-scoped def registered for key "${opts.key}"`);
  }

  const db = getDb();
  const [row] = await db
    .select({ value: getUserPrefColumn(selfDef.key) })
    .from(users)
    .where(eq(users.id, opts.viewerUserId))
    .limit(1);
  if (row?.value !== undefined && row.value !== null) {
    return row.value as PrefValue;
  }
  return selfDef.default;
}
