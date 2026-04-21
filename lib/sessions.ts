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
  createDiscordBotClient,
  type DiscordBotClient,
} from './discordBot.js';
import { buildSessionInviteMessage } from './proposalMessages.js';
import {
  sessionEvents,
  tradeProposals,
  tradeSessions,
  users,
  type SessionEventType,
  type SessionStatus,
  type TradeCardSnapshot,
} from './schema.js';
import { recordEvent as recordProposalEvent } from './proposalEvents.js';

type Db = ReturnType<typeof getDb>;

/**
 * Short-code id alphabet — uppercase + digits minus the confusable
 * 0/O/1/I. 8 chars at ~32^8 = ~1.1 × 10¹² variants, plenty for
 * any realistic volume of active sessions.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** Guest handle alphabet — lowercase + digits, no confusables. */
const GUEST_HANDLE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const GUEST_HANDLE_LENGTH = 5;

function generateGuestSuffix(): string {
  const bytes = new Uint8Array(GUEST_HANDLE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < GUEST_HANDLE_LENGTH; i++) {
    out += GUEST_HANDLE_ALPHABET[bytes[i] % GUEST_HANDLE_ALPHABET.length];
  }
  return out;
}

/**
 * Create a ghost user row for an anonymous participant — used when
 * someone scans a QR-coded `/s/<code>` URL without being signed in.
 *
 * Ghost invariants:
 *   - `is_anonymous = true`. Every public listing / community query
 *     must exclude these rows (`WHERE is_anonymous = false`).
 *   - `discord_id = null`. Upgrade path via the OAuth callback
 *     merges the ghost row into the real Discord user when they
 *     eventually sign in (ghost id gets rewritten across
 *     trade_sessions, ghost row deleted, session cookie swapped).
 *   - Auto-generated handle (`guest-<5-char-suffix>`) — collision-
 *     resistant enough we never retry; display name "Guest <SUFFIX>".
 *
 * Returns the freshly-inserted row. Caller is expected to set this
 * user as the iron-session cookie's subject so downstream requests
 * see them as authenticated (same cookie shape as a real user).
 */
export interface GhostUser {
  id: string;
  handle: string;
  username: string;
}

export async function createGhostUser(db: Db): Promise<GhostUser> {
  const suffix = generateGuestSuffix();
  const id = `gst-${suffix}`;
  const handle = `guest-${suffix}`;
  const username = `Guest ${suffix.toUpperCase()}`;
  await db.insert(users).values({
    id,
    // discord_id nullable — ghosts have none until they sign in.
    discordId: null,
    username,
    handle,
    avatarUrl: null,
    isAnonymous: true,
  });
  return { id, handle, username };
}

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
    isAnonymous: boolean;
  } | null;
  /** True when slot B hasn't been claimed yet — the session is an
   *  "open" QR/link invitation waiting for a scanner. In this state
   *  `counterpart` is null and the UI shows the invite-and-QR surface
   *  instead of the two-panel trade canvas. */
  openSlot: boolean;
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

  // Counterpart id may be null for open-slot sessions (viewer = A,
  // slot B still waiting for a claim). Skip the user lookup in that
  // case; the view just returns `counterpart: null` and the UI
  // renders the "invite someone" state + QR.
  const viewerIsA = row.userAId === viewerUserId;
  const counterpartId = viewerIsA ? row.userBId : row.userAId;
  const counterpart = counterpartId
    ? (await db
        .select({
          id: users.id,
          handle: users.handle,
          username: users.username,
          avatarUrl: users.avatarUrl,
          isAnonymous: users.isAnonymous,
        })
        .from(users)
        .where(eq(users.id, counterpartId))
        .limit(1))[0]
    : null;

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
          isAnonymous: counterpart.isAnonymous,
        }
      : null,
    openSlot: counterpartId === null,
    yourCards,
    theirCards,
    confirmedByViewer: row.confirmedByUserIds.includes(viewerUserId),
    confirmedByCounterpart: counterpartId !== null && row.confirmedByUserIds.includes(counterpartId),
    lastEditedByViewer: row.lastEditedByUserId === viewerUserId,
    lastEditedAt: row.lastEditedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Preview of an open-slot session — rendered for non-participants
 * who've followed a QR/invite link. Returns the creator's identity
 * so the scanner knows who they're about to trade with, plus a count
 * of cards currently in slot A so they get a sense of what's being
 * proposed. Null for:
 *   - unknown session id
 *   - session is terminal (settled/cancelled/expired)
 *   - session has both slots filled (not an open invitation)
 *
 * Deliberately does NOT return slot-A cards themselves — a scanner
 * shouldn't be able to browse the details until they claim. Keeps
 * "open session URL harvesting" from leaking card lists.
 */
export interface SessionPreview {
  id: string;
  creator: {
    handle: string;
    username: string;
    avatarUrl: string | null;
    isAnonymous: boolean;
  };
  creatorCardCount: number;
  createdAt: string;
  expiresAt: string;
}

export async function getSessionPreview(
  db: Db,
  sessionId: string,
): Promise<SessionPreview | null> {
  const [row] = await db
    .select()
    .from(tradeSessions)
    .where(eq(tradeSessions.id, sessionId))
    .limit(1);
  if (!row) return null;
  if (row.status !== 'active') return null;
  if (row.userBId !== null) return null;

  const [creator] = await db
    .select({
      handle: users.handle,
      username: users.username,
      avatarUrl: users.avatarUrl,
      isAnonymous: users.isAnonymous,
    })
    .from(users)
    .where(eq(users.id, row.userAId))
    .limit(1);
  if (!creator) return null;

  return {
    id: row.id,
    creator,
    creatorCardCount: row.userACards.reduce((n, c) => n + c.qty, 0),
    createdAt: row.createdAt.toISOString(),
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

  // Open-slot sessions have a null counterpart id — filter those
  // out before the user lookup and leave `counterpart: null` in the
  // final view.
  const counterpartIds = Array.from(new Set(
    rows
      .map(r => r.userAId === viewerUserId ? r.userBId : r.userAId)
      .filter((id): id is string => id !== null),
  ));
  const counterpartRows = counterpartIds.length > 0
    ? await db
        .select({
          id: users.id,
          handle: users.handle,
          username: users.username,
          avatarUrl: users.avatarUrl,
          isAnonymous: users.isAnonymous,
        })
        .from(users)
        .where(inArray(users.id, counterpartIds))
    : [];
  const byId = new Map(counterpartRows.map(u => [u.id, u]));

  return rows.map(r => {
    const viewerIsA = r.userAId === viewerUserId;
    const counterpartId = viewerIsA ? r.userBId : r.userAId;
    const counterpart = counterpartId ? byId.get(counterpartId) : null;
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
            isAnonymous: counterpart.isAnonymous,
          }
        : null,
      openSlot: counterpartId === null,
      yourCards: viewerIsA ? r.userACards : r.userBCards,
      theirCards: viewerIsA ? r.userBCards : r.userACards,
      confirmedByViewer: r.confirmedByUserIds.includes(viewerUserId),
      confirmedByCounterpart: counterpartId !== null && r.confirmedByUserIds.includes(counterpartId),
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

/**
 * Create a new active session between two signed-in users, seeded
 * with the proposer's starting half. Returns either `{ created: true,
 * id }` or `{ created: false, id }` when an active session already
 * existed (caller redirects into the existing one).
 *
 * Pair uniqueness is enforced both here (explicit lookup) AND by the
 * partial unique index — the lookup handles the happy path cleanly,
 * the index is the belt-and-suspenders guard against races.
 */
export async function createOrGetActiveSession(
  db: Db,
  args: {
    creatorUserId: string;
    counterpartUserId: string;
    /** Creator's starting half. Counterpart starts empty. */
    creatorCards?: TradeCardSnapshot[];
  },
): Promise<{ created: boolean; id: string }> {
  const existing = await findActiveSessionForPair(db, args.creatorUserId, args.counterpartUserId);
  if (existing) return { created: false, id: existing };

  const id = generateSessionCode();
  const { userAId, userBId } = normalizeParticipants(args.creatorUserId, args.counterpartUserId);
  const creatorIsA = userAId === args.creatorUserId;
  const creatorCards = args.creatorCards ?? [];

  try {
    await db.insert(tradeSessions).values({
      id,
      userAId,
      userBId,
      userACards: creatorIsA ? creatorCards : [],
      userBCards: creatorIsA ? [] : creatorCards,
      status: 'active',
      confirmedByUserIds: [],
      lastEditedByUserId: creatorCards.length > 0 ? args.creatorUserId : null,
      lastNotifiedAt: {},
      expiresAt: nextExpiresAt(),
    });
  } catch (err) {
    // Race: another create landed between our lookup and our insert.
    // Re-lookup and return the winner's id. The partial unique index
    // on (user_a_id, user_b_id) WHERE status='active' is what rejects
    // the second insert.
    const winner = await findActiveSessionForPair(db, args.creatorUserId, args.counterpartUserId);
    if (winner) return { created: false, id: winner };
    throw err;
  }

  await recordSessionEvent(db, {
    sessionId: id,
    actorUserId: args.creatorUserId,
    type: 'created',
  });
  return { created: true, id };
}

/**
 * Create an "open-slot" session — slot A is the creator, slot B is
 * null. Used by the QR / in-person flow: the creator starts a
 * session, shares the URL, and whoever scans becomes the slot B
 * participant (via `claimOpenSlot`).
 *
 * Unlike `createOrGetActiveSession`, there's no pair uniqueness
 * guarantee here — a single user can have multiple open-slot
 * sessions simultaneously (e.g. running two tables at the same LGS).
 * The partial unique index only kicks in once slot B is filled.
 */
export async function createOpenSession(
  db: Db,
  args: {
    creatorUserId: string;
    /** Creator's half, seeded on insert. */
    creatorCards?: TradeCardSnapshot[];
    /** Counterpart's half, pre-seeded while slot B is still open.
     *  Used to promote a calculator-in-progress ("Hi, here's what
     *  I'm offering and what I want from you") into a session the
     *  scanner can review and tweak. Kept when slot B is claimed —
     *  the claimer inherits the pre-seeded half and can edit from
     *  there. Defaults to an empty array. */
    counterpartInitialCards?: TradeCardSnapshot[];
  },
): Promise<{ id: string }> {
  const id = generateSessionCode();
  const creatorCards = args.creatorCards ?? [];
  const counterpartCards = args.counterpartInitialCards ?? [];
  await db.insert(tradeSessions).values({
    id,
    userAId: args.creatorUserId,
    userBId: null,
    userACards: creatorCards,
    userBCards: counterpartCards,
    status: 'active',
    confirmedByUserIds: [],
    lastEditedByUserId: creatorCards.length > 0 || counterpartCards.length > 0
      ? args.creatorUserId
      : null,
    lastNotifiedAt: {},
    expiresAt: nextExpiresAt(),
  });
  await recordSessionEvent(db, {
    sessionId: id,
    actorUserId: args.creatorUserId,
    type: 'created',
    payload: { openSlot: true },
  });
  return { id };
}

/**
 * Fill the second slot of an open session with the viewer. Handles
 * every participant edge case:
 *   - Session already has both slots filled, viewer is one of them
 *     → no-op success (idempotent on re-scan)
 *   - Session already has both slots filled, viewer is NOT a
 *     participant → 'conflict' (someone else got there first)
 *   - Slot B is null, viewer is the creator → 'self' (can't claim
 *     your own session)
 *   - Slot B is null, viewer is someone else → fill it
 *   - Session is terminal → 'terminal'
 */
export type ClaimOpenSlotResult =
  | { ok: true; view: SessionView; claimed: boolean }
  | { ok: false; reason: 'not-found' | 'self' | 'conflict' | 'terminal' };

export async function claimOpenSlot(
  db: Db,
  args: { sessionId: string; viewerUserId: string },
): Promise<ClaimOpenSlotResult> {
  const [row] = await db
    .select()
    .from(tradeSessions)
    .where(eq(tradeSessions.id, args.sessionId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.status !== 'active') return { ok: false, reason: 'terminal' };

  // Already a participant — idempotent no-op.
  if (row.userAId === args.viewerUserId || row.userBId === args.viewerUserId) {
    const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
    if (!view) return { ok: false, reason: 'not-found' };
    return { ok: true, view, claimed: false };
  }

  // Slot B filled by someone else — race loser.
  if (row.userBId !== null) return { ok: false, reason: 'conflict' };

  // Slot B null → fill. Normalise the pair to satisfy the canonical
  // a<b ordering the rest of the codebase relies on; if the claimer's
  // id sorts before the creator's, we swap the slot assignment and
  // keep the cards aligned with whoever owns them.
  const { userAId, userBId } = normalizeParticipants(row.userAId, args.viewerUserId);
  const creatorStaysInA = userAId === row.userAId;
  const now = new Date();

  try {
    await db
      .update(tradeSessions)
      .set({
        userAId,
        userBId,
        // If the sort flipped, the cards swap columns too — creator's
        // cards always travel with the creator's id.
        userACards: creatorStaysInA ? row.userACards : row.userBCards,
        userBCards: creatorStaysInA ? row.userBCards : row.userACards,
        updatedAt: now,
        // Bump expiry so the session doesn't time out just because
        // the scan happened close to the original expires_at.
        expiresAt: nextExpiresAt(now),
      })
      .where(eq(tradeSessions.id, args.sessionId));
  } catch (err) {
    // Race: another claim landed between our read and write (partial
    // unique index on `(user_a_id, user_b_id) WHERE user_b_id IS NOT
    // NULL` isn't relevant here, but the pair-uniqueness index would
    // reject if the claimer already had a separate active session
    // with the creator). Return conflict and let the client decide.
    return { ok: false, reason: 'conflict' };
  }

  await recordSessionEvent(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    type: 'created',
    payload: { claimed: true },
  });

  const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
  if (!view) return { ok: false, reason: 'not-found' };
  return { ok: true, view, claimed: true };
}

/**
 * Replace the viewer's half of a session. Per-side ownership:
 * a viewer can only edit their own cards, never the counterpart's.
 * Any edit clears the confirmed_by array — both parties must re-
 * confirm after any mutation.
 *
 * Extends the expiry window so an active back-and-forth doesn't
 * expire mid-negotiation. The lastEditedBy bookkeeping feeds the
 * debounced-DM job in a later sliver.
 *
 * Returns the updated session view or a reason string for known
 * failure modes (`not-found`, `not-participant`, `terminal`).
 */
export type EditSessionResult =
  | { ok: true; view: SessionView }
  | { ok: false; reason: 'not-found' | 'not-participant' | 'terminal' };

export async function editSessionSide(
  db: Db,
  args: {
    sessionId: string;
    viewerUserId: string;
    cards: TradeCardSnapshot[];
  },
): Promise<EditSessionResult> {
  const [row] = await db
    .select()
    .from(tradeSessions)
    .where(eq(tradeSessions.id, args.sessionId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.userAId !== args.viewerUserId && row.userBId !== args.viewerUserId) {
    return { ok: false, reason: 'not-participant' };
  }
  if (row.status !== 'active') return { ok: false, reason: 'terminal' };

  const viewerIsA = row.userAId === args.viewerUserId;
  const now = new Date();

  // Snapshot whether the counterpart had confirmed before this edit
  // so the event payload can say "cleared N confirmations." Useful
  // for the future timeline UI.
  const priorConfirmations = row.confirmedByUserIds.length;

  await db
    .update(tradeSessions)
    .set({
      userACards: viewerIsA ? args.cards : row.userACards,
      userBCards: viewerIsA ? row.userBCards : args.cards,
      // Every edit clears confirmations — the counterpart needs to
      // see the new state before confirming again.
      confirmedByUserIds: [],
      lastEditedAt: now,
      lastEditedByUserId: args.viewerUserId,
      updatedAt: now,
      // Bump expiry forward on active use.
      expiresAt: nextExpiresAt(now),
    })
    .where(eq(tradeSessions.id, args.sessionId));

  await recordSessionEvent(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    type: 'edited',
    payload: { side: viewerIsA ? 'a' : 'b', count: args.cards.length },
  });

  if (priorConfirmations > 0) {
    await recordSessionEvent(db, {
      sessionId: args.sessionId,
      actorUserId: args.viewerUserId,
      type: 'unconfirmed',
      payload: { cleared: priorConfirmations },
    });
  }

  const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
  if (!view) return { ok: false, reason: 'not-found' };
  return { ok: true, view };
}

/**
 * Add the viewer to confirmed_by_user_ids. If the counterpart is
 * also already confirmed, the transition is settle-and-freeze: the
 * session moves to `settled` and `settled_at` captures the moment.
 *
 * Idempotent — confirming twice is a no-op.
 */
export type ConfirmSessionResult =
  | { ok: true; view: SessionView; settled: boolean }
  | { ok: false; reason: 'not-found' | 'not-participant' | 'terminal' };

export async function confirmSession(
  db: Db,
  args: { sessionId: string; viewerUserId: string },
): Promise<ConfirmSessionResult> {
  const [row] = await db
    .select()
    .from(tradeSessions)
    .where(eq(tradeSessions.id, args.sessionId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.userAId !== args.viewerUserId && row.userBId !== args.viewerUserId) {
    return { ok: false, reason: 'not-participant' };
  }
  if (row.status !== 'active') return { ok: false, reason: 'terminal' };

  // Already confirmed — idempotent no-op beyond re-fetch for the
  // caller's rendered view.
  if (row.confirmedByUserIds.includes(args.viewerUserId)) {
    const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
    return view
      ? { ok: true, view, settled: false }
      : { ok: false, reason: 'not-found' };
  }

  const counterpartId = row.userAId === args.viewerUserId ? row.userBId : row.userAId;
  // Open-slot session (no counterpart yet): confirming is allowed
  // but can never settle because the counterpart isn't set. Settle
  // waits for the claim + their subsequent confirm.
  const counterpartAlreadyConfirmed = counterpartId !== null
    && row.confirmedByUserIds.includes(counterpartId);
  const nextConfirmations = [...row.confirmedByUserIds, args.viewerUserId];
  const settling = counterpartAlreadyConfirmed;
  const now = new Date();

  await db
    .update(tradeSessions)
    .set({
      confirmedByUserIds: nextConfirmations,
      ...(settling ? { status: 'settled' as const, settledAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(tradeSessions.id, args.sessionId));

  await recordSessionEvent(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    type: 'confirmed',
  });
  if (settling) {
    await recordSessionEvent(db, {
      sessionId: args.sessionId,
      actorUserId: args.viewerUserId,
      type: 'settled',
    });
  }

  const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
  if (!view) return { ok: false, reason: 'not-found' };
  return { ok: true, view, settled: settling };
}

/**
 * Transition an active session to `cancelled`. Either participant
 * can cancel. Idempotent — cancelling a terminal session just
 * returns its current view.
 */
export type CancelSessionResult =
  | { ok: true; view: SessionView }
  | { ok: false; reason: 'not-found' | 'not-participant' };

export async function cancelSession(
  db: Db,
  args: { sessionId: string; viewerUserId: string },
): Promise<CancelSessionResult> {
  const [row] = await db
    .select()
    .from(tradeSessions)
    .where(eq(tradeSessions.id, args.sessionId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.userAId !== args.viewerUserId && row.userBId !== args.viewerUserId) {
    return { ok: false, reason: 'not-participant' };
  }

  if (row.status === 'active') {
    const now = new Date();
    await db
      .update(tradeSessions)
      .set({
        status: 'cancelled',
        settledAt: now,
        updatedAt: now,
      })
      .where(eq(tradeSessions.id, args.sessionId));
    await recordSessionEvent(db, {
      sessionId: args.sessionId,
      actorUserId: args.viewerUserId,
      type: 'cancelled',
    });
  }

  const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
  if (!view) return { ok: false, reason: 'not-found' };
  return { ok: true, view };
}

/**
 * Migrate every reference to `ghostId` in `trade_sessions` and
 * `session_events` over to `realUserId`, then delete the ghost row.
 * Called from the OAuth callback when a user signs in via Discord
 * while already carrying a ghost session cookie — their in-progress
 * trades follow them into the real account.
 *
 * Edge case: if the real user already had an active session with
 * the same counterpart a ghost session is tied to, the partial
 * unique index on `(user_a_id, user_b_id) WHERE status='active'`
 * would reject the UPDATE. We swallow per-session errors and leave
 * the conflicting session under the ghost id; when the loop
 * finishes, we only delete the ghost row if NO sessions still
 * reference it (otherwise cascade delete would wipe them).
 *
 * Per-session logic:
 *   - Rewrite the ghost's slot to point at the real user.
 *   - Re-normalise the a/b canonical ordering.
 *   - If the ghost was in `confirmedByUserIds`, carry that
 *     confirmation to the real user.
 *   - If `lastEditedByUserId` was the ghost, promote it to the real
 *     user for the debounce-DM job.
 */
export async function mergeGhostIntoRealUser(
  db: Db,
  ghostId: string,
  realUserId: string,
): Promise<{ migrated: number }> {
  const sessions = await db
    .select()
    .from(tradeSessions)
    .where(or(
      eq(tradeSessions.userAId, ghostId),
      eq(tradeSessions.userBId, ghostId),
    ));

  // Track successful migrations so the caller (OAuth callback) can
  // decide whether to flag a reassurance banner for the user — UX-A5.
  // A zero-count merge (ghost existed but had no sessions, e.g. user
  // opened the app anonymously then signed in without ever claiming
  // anything) shouldn't trigger the banner; the silent-path is fine.
  let migrated = 0;

  for (const s of sessions) {
    const now = new Date();
    try {
      // Slot B null (open invitation created by the ghost) — just
      // rewrite the creator slot.
      if (s.userBId === null) {
        await db
          .update(tradeSessions)
          .set({ userAId: realUserId, updatedAt: now })
          .where(eq(tradeSessions.id, s.id));
        migrated += 1;
        continue;
      }

      const other = s.userAId === ghostId ? s.userBId : s.userAId;
      const { userAId, userBId } = normalizeParticipants(realUserId, other);
      const realInA = userAId === realUserId;
      // Cards travel with whoever owned them, not with slot position.
      const ghostCards = s.userAId === ghostId ? s.userACards : s.userBCards;
      const otherCards = s.userAId === ghostId ? s.userBCards : s.userACards;

      const nextConfirmations = s.confirmedByUserIds.includes(ghostId)
        ? [...s.confirmedByUserIds.filter(id => id !== ghostId), realUserId]
        : s.confirmedByUserIds;

      await db
        .update(tradeSessions)
        .set({
          userAId,
          userBId,
          userACards: realInA ? ghostCards : otherCards,
          userBCards: realInA ? otherCards : ghostCards,
          confirmedByUserIds: nextConfirmations,
          lastEditedByUserId: s.lastEditedByUserId === ghostId
            ? realUserId
            : s.lastEditedByUserId,
          updatedAt: now,
        })
        .where(eq(tradeSessions.id, s.id));
      migrated += 1;
    } catch (err) {
      // Pair-uniqueness conflict: the real user already has an
      // active session with this counterpart. Leave the ghost row
      // alive so the session isn't cascaded into oblivion; the user
      // won't see it in their list but it'll fall out of TTL
      // eventually.
      console.error(
        'mergeGhostIntoRealUser: session migration failed',
        s.id,
        err,
      );
    }
  }

  // Rewrite the event-log actor references. session_events has FK
  // ON DELETE SET NULL so stale refs become null instead of
  // cascading — still safe to do before the ghost delete for
  // cleaner audit history.
  await db
    .update(sessionEvents)
    .set({ actorUserId: realUserId })
    .where(eq(sessionEvents.actorUserId, ghostId));

  // Only delete the ghost if nothing still references it. The
  // trade_sessions FK is ON DELETE CASCADE — deleting a ghost with
  // unmigrated sessions would wipe those sessions.
  const remaining = await db
    .select({ id: tradeSessions.id })
    .from(tradeSessions)
    .where(or(
      eq(tradeSessions.userAId, ghostId),
      eq(tradeSessions.userBId, ghostId),
    ))
    .limit(1);
  if (remaining.length === 0) {
    await db.delete(users).where(eq(users.id, ghostId));
  }

  return { migrated };
}

/**
 * Promote a pending proposal into a shared collaborative session.
 *
 * The recipient of a pending proposal clicks "Edit together" and
 * converts the one-shot ping-pong proposal into a mutable shared
 * canvas. From there, both parties work inside the trade_sessions
 * primitive — edit, confirm, settle — instead of the
 * accept/decline/counter lifecycle.
 *
 * Semantics:
 *   1. Only the RECIPIENT can promote. Proposers who want to iterate
 *      on their own proposal use the existing edit flow — promoting
 *      would be a no-op for them.
 *   2. Only `pending` proposals can be promoted. A terminal proposal
 *      (accepted/declined/cancelled/expired/countered) returns
 *      `not-pending` so the UI can surface the race cleanly.
 *   3. If the pair already has an ACTIVE session, return its id with
 *      `already-active-session` — the caller can redirect the viewer
 *      into that existing canvas rather than creating a parallel one.
 *      Belt for the partial unique index's suspenders.
 *   4. On success: the proposal flips to `countered` (reuses the
 *      existing terminal state — a promoted proposal has effectively
 *      been replaced by the session) and a new session row is seeded
 *      with both parties' cards positioned correctly under the
 *      canonical a<b ordering.
 *
 * Write ordering is deliberate: the session insert commits FIRST, then
 * the proposal transition. If the session insert fails mid-flight the
 * proposal stays pending — the recipient can retry or fall back to
 * accept/decline/counter. If the proposal transition fails after the
 * session insert, the try/catch surfaces `error` (see below) and the
 * orphan session is cleaned up so we don't leave both primitives
 * pointing at each other.
 */
export type PromoteProposalResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      reason: 'not-found' | 'not-recipient' | 'not-pending' | 'already-active-session';
      sessionId?: string;
    };

export async function promoteProposalToSession(
  db: Db,
  args: {
    proposalId: string;
    /** Must be the proposal's recipientUserId — proposers can't
     *  promote their own proposal. */
    viewerUserId: string;
  },
): Promise<PromoteProposalResult> {
  const [proposal] = await db
    .select()
    .from(tradeProposals)
    .where(eq(tradeProposals.id, args.proposalId))
    .limit(1);
  if (!proposal) return { ok: false, reason: 'not-found' };
  if (proposal.recipientUserId !== args.viewerUserId) {
    return { ok: false, reason: 'not-recipient' };
  }
  if (proposal.status !== 'pending') {
    return { ok: false, reason: 'not-pending' };
  }

  // If the pair already has an active session, hand its id back so
  // the caller can redirect the viewer in. Guards against "propose,
  // forget, then promote a fresh proposal to the same counterpart"
  // creating a parallel canvas — the partial unique index would
  // reject that insert anyway, but the explicit lookup gives the UI
  // a clean way to recover without a 5xx.
  const existing = await findActiveSessionForPair(
    db,
    proposal.proposerUserId,
    proposal.recipientUserId,
  );
  if (existing) {
    return { ok: false, reason: 'already-active-session', sessionId: existing };
  }

  const sessionId = generateSessionCode();
  const { userAId, userBId } = normalizeParticipants(
    proposal.proposerUserId,
    proposal.recipientUserId,
  );
  // Cards travel with the user who owns them. The proposal's
  // offeringCards are the PROPOSER'S contribution; receivingCards are
  // what the proposer wanted from the recipient. After normalisation,
  // whichever slot (A or B) holds the proposer gets the offeringCards;
  // the recipient's slot gets the receivingCards as their starting
  // half. Either side can then edit their own cards freely.
  const proposerIsA = userAId === proposal.proposerUserId;
  const now = new Date();

  try {
    await db.insert(tradeSessions).values({
      id: sessionId,
      userAId,
      userBId,
      userACards: proposerIsA ? proposal.offeringCards : proposal.receivingCards,
      userBCards: proposerIsA ? proposal.receivingCards : proposal.offeringCards,
      status: 'active',
      confirmedByUserIds: [],
      // The recipient just pressed "Edit together" — they're the
      // actor on this row's first action, so the debounce-DM job
      // targets the PROPOSER when it next fires.
      lastEditedByUserId: args.viewerUserId,
      lastNotifiedAt: {},
      expiresAt: nextExpiresAt(now),
    });
  } catch (err) {
    // Belt-and-suspenders against the pair unique index + a race
    // where another promotion landed between our lookup and insert.
    // Re-check and fall back to the winner if one exists.
    const winner = await findActiveSessionForPair(
      db,
      proposal.proposerUserId,
      proposal.recipientUserId,
    );
    if (winner) {
      return { ok: false, reason: 'already-active-session', sessionId: winner };
    }
    throw err;
  }

  // Transition the proposal. If this fails we clean up the session
  // row to avoid orphaning both sides of the promotion.
  try {
    await db
      .update(tradeProposals)
      .set({
        status: 'countered',
        respondedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(tradeProposals.id, proposal.id),
        eq(tradeProposals.status, 'pending'),
      ));
  } catch (err) {
    await db
      .delete(tradeSessions)
      .where(eq(tradeSessions.id, sessionId))
      .catch((cleanupErr) => {
        // Orphan session cleanup failed — log so it's traceable in
        // audit, but surface the original transition error to the
        // caller (which matters for debugging the primary failure).
        console.error(
          'promoteProposalToSession: orphan session cleanup failed',
          sessionId,
          cleanupErr,
        );
      });
    throw err;
  }

  // Event bookkeeping — best-effort, same pattern as elsewhere.
  // Session-side: reuse `created` with a `promotedFromProposalId`
  // payload flag so the timeline can distinguish a promoted session
  // from a direct-create without adding a new event type.
  // Proposal-side: `countered` with the new session id so the
  // proposal timeline shows what happened to it.
  await recordSessionEvent(db, {
    sessionId,
    actorUserId: args.viewerUserId,
    type: 'created',
    payload: { promotedFromProposalId: proposal.id },
  });
  await recordProposalEvent(db, {
    proposalId: proposal.id,
    actorUserId: args.viewerUserId,
    type: 'countered',
    payload: { promotedToSessionId: sessionId },
  });

  return { ok: true, sessionId };
}

/**
 * Invite a specific SWUTrade handle to an open-slot session via a
 * Discord DM carrying the session URL. Alternative to the QR / share-
 * link affordance — the creator picks a known handle and the server
 * delivers the URL directly to the invitee's DMs.
 *
 * Invariants:
 *   - Only the session CREATOR (slot A) can invite.
 *   - Session must be `active` and have `user_b_id === null`. If slot
 *     B is already filled OR the session is terminal, invites are
 *     rejected with `not-open`.
 *   - Self-invites are rejected (`self-invite`).
 *   - Debounce: identical invites (same target handle) within the
 *     DEBOUNCE_WINDOW_MS of the last successful invite are suppressed.
 *     Returns `ok: true` idempotently so repeat clicks from the UI are
 *     safe; a debug event is logged to explain why no DM went out.
 *   - The DM is sent via `DiscordBotClient.sendDirectMessage`. Any
 *     thrown error collapses to `dm-failed` (bot has no DM perms, user
 *     has DMs disabled, etc.); the session + event log stay untouched
 *     so the creator can retry.
 *   - On success, a `notified` event is recorded with payload
 *     `{ kind: 'invite', targetUserId, targetHandle }`. We re-use the
 *     existing `notified` type rather than adding a new enum value to
 *     avoid a schema migration — the payload disambiguates.
 */
export const SESSION_INVITE_DEBOUNCE_MS = 10 * 60 * 1000;

export async function inviteHandleToSession(
  db: Db,
  args: {
    sessionId: string;
    viewerUserId: string;
    targetHandle: string;
    bot?: DiscordBotClient;
    /** Absolute base URL for the outbound link (e.g.
     *  `https://beta.swutrade.com`). Falls back to the beta origin
     *  so unit tests + local scripts don't need to thread it through. */
    appBaseUrl?: string;
  },
): Promise<
  | { ok: true; invited: { userId: string; handle: string } }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'not-creator'
        | 'not-open'
        | 'self-invite'
        | 'no-such-handle'
        | 'dm-failed';
    }
> {
  const [sessionRow] = await db
    .select()
    .from(tradeSessions)
    .where(eq(tradeSessions.id, args.sessionId))
    .limit(1);
  if (!sessionRow) return { ok: false, reason: 'not-found' };

  // "Open" here means both: session is active AND slot B is still
  // null. A terminal session OR a fully-claimed pair both collapse to
  // 'not-open' because in either case the invite-by-handle surface
  // has nothing useful to do.
  if (sessionRow.status !== 'active' || sessionRow.userBId !== null) {
    return { ok: false, reason: 'not-open' };
  }
  if (sessionRow.userAId !== args.viewerUserId) {
    return { ok: false, reason: 'not-creator' };
  }

  // Normalize the handle — strip leading `@` and whitespace. Accept
  // `@alice`, `alice`, `  @alice  `, etc. as the same lookup.
  const handle = args.targetHandle.trim().replace(/^@+/, '');
  if (!handle) return { ok: false, reason: 'no-such-handle' };

  const [target] = await db
    .select({ id: users.id, handle: users.handle, discordId: users.discordId })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  if (!target) return { ok: false, reason: 'no-such-handle' };
  if (target.id === sessionRow.userAId) {
    return { ok: false, reason: 'self-invite' };
  }

  // Need the inviter's own handle for the DM body.
  const [inviter] = await db
    .select({ handle: users.handle })
    .from(users)
    .where(eq(users.id, args.viewerUserId))
    .limit(1);
  if (!inviter) return { ok: false, reason: 'not-creator' };

  // Debounce: scan session_events for recent `notified` rows that
  // targeted this same handle. Any hit within the window collapses
  // to a successful no-op so users who tap Invite twice don't trip
  // Discord's DM-spam heuristics.
  const debounceCutoff = new Date(Date.now() - SESSION_INVITE_DEBOUNCE_MS);
  const priorInvites = await db
    .select({ id: sessionEvents.id, payload: sessionEvents.payload })
    .from(sessionEvents)
    .where(and(
      eq(sessionEvents.sessionId, args.sessionId),
      eq(sessionEvents.type, 'notified'),
      gt(sessionEvents.createdAt, debounceCutoff),
    ));
  const recentlyInvited = priorInvites.some(e => {
    const p = e.payload as
      | { kind?: string; targetHandle?: string; targetUserId?: string }
      | null;
    if (!p || p.kind !== 'invite') return false;
    return p.targetHandle === handle || p.targetUserId === target.id;
  });
  if (recentlyInvited) {
    // Leave a breadcrumb so the timeline answers "why didn't @alice
    // get a second DM?" without needing to correlate logs.
    await recordSessionEvent(db, {
      sessionId: args.sessionId,
      actorUserId: args.viewerUserId,
      type: 'notified',
      payload: {
        kind: 'invite-debounced',
        targetHandle: handle,
        targetUserId: target.id,
      },
    });
    return { ok: true, invited: { userId: target.id, handle } };
  }

  // Ghost / anonymous targets have no discord_id and therefore no DM
  // channel we can open. Surface that as 'dm-failed' — same UX as "we
  // tried and it didn't land," and the caller can offer the QR/share-
  // link alternative.
  if (!target.discordId) {
    return { ok: false, reason: 'dm-failed' };
  }

  const baseUrl = args.appBaseUrl ?? 'https://beta.swutrade.com';
  const sessionUrl = `${baseUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(args.sessionId)}`;
  const body = buildSessionInviteMessage({
    inviterHandle: inviter.handle,
    sessionUrl,
  });

  const bot = args.bot ?? createDiscordBotClient();
  try {
    await bot.sendDirectMessage(target.discordId, body);
  } catch (err) {
    console.error(
      'inviteHandleToSession: sendDirectMessage failed',
      args.sessionId,
      target.id,
      err,
    );
    return { ok: false, reason: 'dm-failed' };
  }

  await recordSessionEvent(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    type: 'notified',
    payload: {
      kind: 'invite',
      targetHandle: handle,
      targetUserId: target.id,
    },
  });

  return { ok: true, invited: { userId: target.id, handle } };
}

// Expose drizzle helpers that future files will reuse so we don't
// fan out the imports across call sites.
export { sql, gt };
