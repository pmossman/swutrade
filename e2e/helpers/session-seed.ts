import { config } from 'dotenv';

config({ path: '.env.local' });

/**
 * Direct-DB seeding helpers for trade-session e2e specs.
 *
 * Two use cases:
 *   1. Phase C frozen-fixture regression — insert sessions in old
 *      schema shapes (pre-suggestions, pre-diff-payload, etc.) so we
 *      can verify current code still renders + accepts edits without
 *      crashing.
 *   2. Phase D Discord-identity preset sessions — build a session
 *      between two known test users without going through the
 *      open-slot QR flow, faster and more deterministic.
 *
 * Implementation notes:
 *   - Imports of `lib/db.js` / `lib/schema.js` are dynamic so this
 *     module is safe to import even from anonymous specs (which lack
 *     DATABASE_URL).
 *   - All inserts include explicit ids so cleanup is deterministic.
 *   - Cleanup is the caller's responsibility — every helper returns a
 *     `cleanup()` function. Specs run it in a `finally` so leftover
 *     rows don't accumulate in the preview Postgres.
 */

export interface SeedSessionEvent {
  /** Optional explicit id; auto-generated if omitted. */
  id?: string;
  type: string;
  actorUserId?: string | null;
  payload?: Record<string, unknown> | null;
  /** Optional explicit timestamp; defaults to now(). */
  createdAt?: Date;
}

export interface SeedSessionOptions {
  /** Optional explicit session id (8-char alphanumeric). Auto-generated otherwise. */
  id?: string;
  userAId: string;
  userBId?: string | null;
  userACards?: unknown[];
  userBCards?: unknown[];
  status?: 'active' | 'settled' | 'cancelled' | 'expired';
  confirmedByUserIds?: string[];
  /** Defaults to 7 days from now. */
  expiresAt?: Date;
  /** PendingSuggestion[] to drop into the JSONB column. */
  pendingSuggestions?: unknown[];
  /** Events to insert AFTER the session row, in chronological order. */
  events?: SeedSessionEvent[];
}

export interface SeededSession {
  sessionId: string;
  cleanup: () => Promise<void>;
}

/**
 * Insert a trade_sessions row + optional events directly into Postgres.
 * Returns the session id and a cleanup function. The session_events
 * rows cascade-delete with the parent row, so cleanup is one query.
 */
export async function seedSession(opts: SeedSessionOptions): Promise<SeededSession> {
  const { getDb } = await import('../../lib/db.js');
  const { tradeSessions, sessionEvents } = await import('../../lib/schema.js');
  const { eq } = await import('drizzle-orm');

  const db = getDb();
  const sessionId = opts.id ?? generateSessionId();

  await db.insert(tradeSessions).values({
    id: sessionId,
    userAId: opts.userAId,
    userBId: opts.userBId ?? null,
    // Drizzle's $type-narrowed JSONB columns won't accept `unknown[]`
    // without an assertion — these helpers are the boundary so the
    // assertion lives here, not in every caller.
    userACards: (opts.userACards ?? []) as never,
    userBCards: (opts.userBCards ?? []) as never,
    status: opts.status ?? 'active',
    confirmedByUserIds: opts.confirmedByUserIds ?? [],
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    pendingSuggestions: (opts.pendingSuggestions ?? []) as never,
  });

  if (opts.events && opts.events.length > 0) {
    let evIdx = 0;
    for (const ev of opts.events) {
      await db.insert(sessionEvents).values({
        id: ev.id ?? `${sessionId}-ev-${evIdx++}`,
        sessionId,
        actorUserId: ev.actorUserId ?? null,
        type: ev.type as never,
        payload: (ev.payload ?? null) as never,
        ...(ev.createdAt ? { createdAt: ev.createdAt } : {}),
      });
    }
  }

  return {
    sessionId,
    async cleanup() {
      await db.delete(tradeSessions).where(eq(tradeSessions.id, sessionId)).catch(() => {});
    },
  };
}

/**
 * Load a frozen-session JSON fixture from `tests/e2e-fixtures/sessions/`
 * and seed it. The fixture's userAId / userBId references must already
 * exist in the users table — wrap with `ensureTestUser()` calls in the
 * spec setup if needed.
 */
export interface SessionFixture {
  /** Human-readable name for this fixture (used in test descriptions). */
  name: string;
  /** Schema generation this fixture represents (pre-suggestions, etc.). */
  generation: string;
  session: Omit<SeedSessionOptions, 'events'> & { id: string };
  events?: SeedSessionEvent[];
}

export async function seedFromFixture(fixture: SessionFixture): Promise<SeededSession> {
  return seedSession({ ...fixture.session, events: fixture.events });
}

/**
 * Generate an 8-char alphanumeric session id matching production's
 * unambiguous-alphabet convention (no 0/O/1/I/l). Collisions across
 * parallel workers are vanishingly unlikely at this length, but the
 * `id` option lets callers force a specific value if they need it.
 */
export function generateSessionId(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}
