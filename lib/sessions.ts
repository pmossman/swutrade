/**
 * Shared helpers for Phase 5b trade sessions.
 *
 * The schema + index layer in `schema.ts` guarantees:
 *   - at most one active session per sorted participant pair
 *   - participants stored canonically (user_a_id < user_b_id)
 *
 * This module's job is to keep those invariants honest at the app
 * layer: sort participants before insert, re-hydrate rows into a
 * viewer-centric shape (your cards vs their cards) on read, and
 * encapsulate the event-log writes that every state transition fires.
 */
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { getDb } from './db.js';
import {
  sessionEvents,
  tradeSessions,
  users,
  type SessionEventType,
  type SessionStatus,
  type TradeCardSnapshot,
} from './schema.js';

type Db = ReturnType<typeof getDb>;

/**
 * Short-code id alphabet — uppercase + digits minus the confusable
 * 0/O/1/I. 8 chars at ~32^8 = ~1.1 × 10¹² variants, plenty for
 * any realistic volume of active sessions.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function generateSessionCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Sort two user ids so they pair up deterministically. Storage layer
 * relies on `user_a_id < user_b_id`; callers building a new row MUST
 * pass the result through this before insert.
 */
export function normalizeParticipants(a: string, b: string): { userAId: string; userBId: string } {
  return a < b
    ? { userAId: a, userBId: b }
    : { userAId: b, userBId: a };
}

/**
 * Viewer-centric view of a session row. Hides the canonical
 * a/b ordering from UI consumers — callers work in terms of "mine"
 * vs "theirs" and never have to remember which physical column their
 * viewer maps to.
 *
 * Card arrays mirror `TradeCardSnapshot` for render-layer reuse
 * with the existing proposal summary components.
 */
export interface SessionView {
  id: string;
  status: SessionStatus;
  viewer: { userId: string };
  counterpart: {
    userId: string;
    handle: string;
    username: string;
    avatarUrl: string | null;
  } | null;
  yourCards: TradeCardSnapshot[];
  theirCards: TradeCardSnapshot[];
  confirmedByViewer: boolean;
  confirmedByCounterpart: boolean;
  lastEditedByViewer: boolean;
  lastEditedAt: string;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  expiresAt: string;
}

/**
 * Fetch one session by short code, gated on the viewer being a
 * participant. Returns `null` for not-found AND for wrong-viewer
 * (same 404-on-both-conditions policy as trade_proposals detail —
 * session ids aren't probeable by non-participants).
 */
export async function getSessionForViewer(
  db: Db,
  sessionId: string,
  viewerUserId: string,
): Promise<SessionView | null> {
  const [row] = await db
    .select()
    .from(tradeSessions)
    .where(eq(tradeSessions.id, sessionId))
    .limit(1);
  if (!row) return null;
  if (row.userAId !== viewerUserId && row.userBId !== viewerUserId) return null;

  const counterpartId = row.userAId === viewerUserId ? row.userBId : row.userAId;
  const [counterpart] = await db
    .select({
      id: users.id,
      handle: users.handle,
      username: users.username,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, counterpartId))
    .limit(1);

  const viewerIsA = row.userAId === viewerUserId;
  const yourCards = viewerIsA ? row.userACards : row.userBCards;
  const theirCards = viewerIsA ? row.userBCards : row.userACards;

  return {
    id: row.id,
    status: row.status,
    viewer: { userId: viewerUserId },
    counterpart: counterpart
      ? {
          userId: counterpart.id,
          handle: counterpart.handle,
          username: counterpart.username,
          avatarUrl: counterpart.avatarUrl,
        }
      : null,
    yourCards,
    theirCards,
    confirmedByViewer: row.confirmedByUserIds.includes(viewerUserId),
    confirmedByCounterpart: row.confirmedByUserIds.includes(counterpartId),
    lastEditedByViewer: row.lastEditedByUserId === viewerUserId,
    lastEditedAt: row.lastEditedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * List active sessions involving the viewer, most-recently-edited
 * first. Expired/cancelled/settled rows are excluded — the Home
 * "active sessions" surface cares about what's still open.
 *
 * Each row is rehydrated viewer-centric like `getSessionForViewer`
 * so the UI never has to know about the a/b canonical ordering.
 */
export async function listActiveSessionsForViewer(
  db: Db,
  viewerUserId: string,
  opts: { limit?: number } = {},
): Promise<SessionView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  const rows = await db
    .select()
    .from(tradeSessions)
    .where(and(
      or(
        eq(tradeSessions.userAId, viewerUserId),
        eq(tradeSessions.userBId, viewerUserId),
      ),
      eq(tradeSessions.status, 'active'),
    ))
    .orderBy(desc(tradeSessions.lastEditedAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const counterpartIds = Array.from(new Set(
    rows.map(r => r.userAId === viewerUserId ? r.userBId : r.userAId),
  ));
  const counterpartRows = await db
    .select({
      id: users.id,
      handle: users.handle,
      username: users.username,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, counterpartIds));
  const byId = new Map(counterpartRows.map(u => [u.id, u]));

  return rows.map(r => {
    const counterpartId = r.userAId === viewerUserId ? r.userBId : r.userAId;
    const counterpart = byId.get(counterpartId);
    const viewerIsA = r.userAId === viewerUserId;
    return {
      id: r.id,
      status: r.status,
      viewer: { userId: viewerUserId },
      counterpart: counterpart
        ? {
            userId: counterpart.id,
            handle: counterpart.handle,
            username: counterpart.username,
            avatarUrl: counterpart.avatarUrl,
          }
        : null,
      yourCards: viewerIsA ? r.userACards : r.userBCards,
      theirCards: viewerIsA ? r.userBCards : r.userACards,
      confirmedByViewer: r.confirmedByUserIds.includes(viewerUserId),
      confirmedByCounterpart: r.confirmedByUserIds.includes(counterpartId),
      lastEditedByViewer: r.lastEditedByUserId === viewerUserId,
      lastEditedAt: r.lastEditedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      settledAt: r.settledAt?.toISOString() ?? null,
      expiresAt: r.expiresAt.toISOString(),
    };
  });
}

/**
 * Find the existing active session between two users, if any. Used
 * by the create endpoint to redirect into an existing session rather
 * than creating a parallel one (the partial unique index on the DB
 * side is the belt; this is the suspenders).
 */
export async function findActiveSessionForPair(
  db: Db,
  userA: string,
  userB: string,
): Promise<string | null> {
  const { userAId, userBId } = normalizeParticipants(userA, userB);
  const [row] = await db
    .select({ id: tradeSessions.id })
    .from(tradeSessions)
    .where(and(
      eq(tradeSessions.userAId, userAId),
      eq(tradeSessions.userBId, userBId),
      eq(tradeSessions.status, 'active'),
    ))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Insert a single event row. Same fire-and-forget pattern as
 * `proposalEvents.recordEvent` — a failed event log shouldn't roll
 * back the parent state transition.
 */
export async function recordSessionEvent(
  db: Db,
  opts: {
    sessionId: string;
    actorUserId: string | null;
    type: SessionEventType;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.insert(sessionEvents).values({
      id: crypto.randomUUID(),
      sessionId: opts.sessionId,
      actorUserId: opts.actorUserId,
      type: opts.type,
      payload: opts.payload ?? null,
    });
  } catch (err) {
    // Audit-log loss, not correctness loss. Don't let a telemetry
    // insert hiccup roll back the parent state change.
    console.error(
      'sessions.recordSessionEvent: insert failed',
      opts.type,
      opts.sessionId,
      err,
    );
  }
}

/**
 * Default session TTL — 14 days from last edit, refreshed each time
 * either party mutates the row. Longer than proposal TTL (30 days
 * absolute from creation) because sessions are expected to span
 * days-to-weeks of async back-and-forth and we don't want to expire
 * a session just because life got in the way for a week.
 *
 * Shorter than a month so settled-never records don't accumulate
 * forever — if both sides drop it for 2 weeks, it's dead.
 */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function nextExpiresAt(fromDate: Date = new Date()): Date {
  return new Date(fromDate.getTime() + SESSION_TTL_MS);
}

// Expose drizzle helpers that future files (create/edit endpoints)
// will reuse so we don't fan out the imports across call sites.
export { sql, gt };
