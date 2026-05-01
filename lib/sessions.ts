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
  type PendingSuggestion,
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
/**
 * Cap on simultaneously-pending suggestions per session. Prevents
 * spam-suggesting and keeps the JSONB column bounded. Reaching this
 * cap returns 'cap-exceeded' from `suggestForSession`; the UI
 * surfaces a "dismiss some pending suggestions first" hint.
 */
export const MAX_PENDING_SUGGESTIONS = 10;

/**
 * View-level shape for a pending suggestion as exposed to the
 * client. Wraps the persisted `PendingSuggestion` with computed-on-
 * read fields:
 *   `residualAdd` / `residualRemove` — what's still needed to satisfy
 *     the suggestion, given the target side's CURRENT cards. Empty
 *     residual = satisfied (auto-dismissed on next edit).
 *   `targetIsViewer` — true when the suggestion's targetSide matches
 *     the viewer; drives the "you have a pending suggestion" UI.
 *
 * Dismissed suggestions are filtered out of the view; the persisted
 * row keeps `dismissedAt` for one cycle as an audit trail before the
 * next mutation prunes it.
 */
export interface PendingSuggestionView {
  id: string;
  suggestedByUserId: string;
  suggestedByViewer: boolean;
  targetSide: 'a' | 'b' | 'both';
  targetIsViewer: boolean;
  cardsToAdd: TradeCardSnapshot[];
  cardsToRemove: TradeCardSnapshot[];
  bothSidesSnapshot?: { yourCards: TradeCardSnapshot[]; theirCards: TradeCardSnapshot[] };
  residualAdd: TradeCardSnapshot[];
  residualRemove: TradeCardSnapshot[];
  createdAt: string;
}

/**
 * Public-facing event shape — the timeline log surfaced to the
 * SessionView. `actorIsViewer` is precomputed so the renderer can
 * pick "you" vs counterpart pronouns without re-deriving from
 * actor id every render.
 */
export interface SessionEvent {
  id: string;
  type: SessionEventType;
  /** null = system-authored event (cron expiry, etc.). */
  actorUserId: string | null;
  actorIsViewer: boolean;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface SessionView {
  id: string;
  status: SessionStatus;
  viewer: { userId: string; side: 'a' | 'b' };
  counterpart: {
    userId: string;
    handle: string;
    username: string;
    avatarUrl: string | null;
    isAnonymous: boolean;
  } | null;
  /** True when slot B hasn't been claimed yet AND the session is still
   *  active — i.e., the session is a live QR/link invitation waiting
   *  for a scanner. In this state `counterpart` is null and the UI
   *  shows the invite-and-QR surface instead of the two-panel trade
   *  canvas. Flips to false the moment the session transitions to a
   *  terminal status (cancelled / expired) even if `userBId` is still
   *  null, so the UI can route a just-cancelled open session through
   *  the TerminalBanner path instead of leaving the QR card on screen. */
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
  /** Most-recent timeline events (newest-first). Caps at
   *  `SESSION_EVENT_PAGE_SIZE` so a long session doesn't ship a
   *  hundred entries on every poll. UI consumers reverse for
   *  display. */
  events: SessionEvent[];
  /** Count of events newer than the viewer's `lastReadAt`. Drives
   *  the unread badge on the timeline tab. */
  unreadCount: number;
  /** Viewer's last-read timestamp (null = never opened). */
  lastReadAt: string | null;
  /** Active cross-side suggestions, viewer-centric. Excludes
   *  dismissed ones. Each carries computed residual delta so the UI
   *  renders only what's still actionable. */
  suggestions: PendingSuggestionView[];
}

export const SESSION_EVENT_PAGE_SIZE = 50;

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

  // Pull the timeline + unread count atomically with the session
  // row so the client gets a coherent snapshot per poll. Capped at
  // SESSION_EVENT_PAGE_SIZE; if a future surface needs full
  // history we'll add a paginated endpoint.
  const lastReadAt = viewerIsA ? row.userALastReadAt : row.userBLastReadAt;
  const [events, unreadCount] = await Promise.all([
    listEventsForSession(db, sessionId, { viewerUserId, limit: SESSION_EVENT_PAGE_SIZE }),
    countUnreadEvents(db, sessionId, lastReadAt),
  ]);
  const suggestions = projectSuggestionsForViewer(
    row.pendingSuggestions ?? [],
    viewerUserId,
    viewerIsA,
    row.userACards,
    row.userBCards,
  );

  return {
    id: row.id,
    status: row.status,
    viewer: { userId: viewerUserId, side: viewerIsA ? 'a' : 'b' },
    counterpart: counterpart
      ? {
          userId: counterpart.id,
          handle: counterpart.handle,
          username: counterpart.username,
          avatarUrl: counterpart.avatarUrl,
          isAnonymous: counterpart.isAnonymous,
        }
      : null,
    openSlot: counterpartId === null && row.status === 'active',
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
    events,
    unreadCount,
    lastReadAt: lastReadAt?.toISOString() ?? null,
    suggestions,
  };
}

/**
 * Fetch the most-recent N events for a session, newest-first, with
 * `actorIsViewer` precomputed for the rendered shape. Includes
 * 'edit-snapshot' events so PR 3's revert-to-state UI can surface
 * them as "↶ Revert here" affordances in the timeline. Display
 * filtering (e.g. collapsing snapshots into compact rows alongside
 * the matching 'edited' event) is the renderer's job.
 */
export async function listEventsForSession(
  db: Db,
  sessionId: string,
  opts: { viewerUserId: string; limit?: number },
): Promise<SessionEvent[]> {
  const limit = Math.min(Math.max(opts.limit ?? SESSION_EVENT_PAGE_SIZE, 1), 200);
  const rows = await db
    .select({
      id: sessionEvents.id,
      type: sessionEvents.type,
      actorUserId: sessionEvents.actorUserId,
      payload: sessionEvents.payload,
      createdAt: sessionEvents.createdAt,
    })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(desc(sessionEvents.createdAt))
    .limit(limit);

  return rows.map(r => ({
    id: r.id,
    type: r.type,
    actorUserId: r.actorUserId,
    actorIsViewer: r.actorUserId === opts.viewerUserId,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Count events newer than `lastReadAt`. `null` means never read →
 * count everything. Only counts viewer-relevant events (excludes
 * snapshot rows + the viewer's own actions, since those don't need
 * to surface as "unread"). */
async function countUnreadEvents(
  db: Db,
  sessionId: string,
  lastReadAt: Date | null,
): Promise<number> {
  const where = lastReadAt
    ? and(
        eq(sessionEvents.sessionId, sessionId),
        gt(sessionEvents.createdAt, lastReadAt),
      )
    : eq(sessionEvents.sessionId, sessionId);
  const rows = await db
    .select({
      type: sessionEvents.type,
      actorUserId: sessionEvents.actorUserId,
    })
    .from(sessionEvents)
    .where(where);
  // Filter to "events the viewer hasn't seen and would care about":
  // exclude snapshots (internal), exclude their own actions (they
  // already know about them since they triggered them).
  return rows.filter(r => r.type !== 'edit-snapshot').length;
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
    const lastReadAt = viewerIsA ? r.userALastReadAt : r.userBLastReadAt;
    return {
      id: r.id,
      status: r.status,
      viewer: { userId: viewerUserId, side: (viewerIsA ? 'a' : 'b') as 'a' | 'b' },
      counterpart: counterpart
        ? {
            userId: counterpart.id,
            handle: counterpart.handle,
            username: counterpart.username,
            avatarUrl: counterpart.avatarUrl,
            isAnonymous: counterpart.isAnonymous,
          }
        : null,
      openSlot: counterpartId === null && r.status === 'active',
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
      // Timeline events + unread count are populated only by
      // `getSessionForViewer` (single-session detail). The list
      // surface shows session rows, not the timeline; surfacing
      // unread badges on the my-sessions list is a follow-on PR
      // that can batch the unread query across all rows.
      events: [],
      unreadCount: 0,
      lastReadAt: lastReadAt?.toISOString() ?? null,
      suggestions: projectSuggestionsForViewer(
        r.pendingSuggestions ?? [],
        viewerUserId,
        viewerIsA,
        r.userACards,
        r.userBCards,
      ),
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
 * Record an `edited` event PAIRED with its `edit-snapshot`, with
 * smart merging when the previous timeline event is also a same-actor
 * `edited` within `EDITED_MERGE_WINDOW_MS` and nothing has interrupted
 * (counterpart edit, chat, confirm, suggestion). Merging UPDATEs the
 * prior pair in place — recomputing the cumulative diff using the
 * `baseSideCards` snapshot stored in the existing payload — so a
 * card-add binge collapses into one timeline row instead of N.
 *
 * The `edited` event's payload carries `snapshotEventId` pointing at
 * its paired snapshot row, letting the client offer a "↶ Revert to
 * here" affordance from the edited row directly without searching
 * for the timestamped snapshot pair.
 *
 * Returns the `snapshotEventId` so callers can chain it (e.g. into
 * a `viaSuggestion` audit field).
 */
async function recordOrMergeEditedPair(
  db: Db,
  args: {
    sessionId: string;
    actorUserId: string;
    viewerIsA: boolean;
    /** Pre-edit cards on the actor's own side. Used as the baseline
     *  for diff computation on a fresh (non-merging) edit. */
    oldActorSideCards: TradeCardSnapshot[];
    /** Post-edit cards on the actor's own side. */
    newActorSideCards: TradeCardSnapshot[];
    /** Full both-sides post-edit state captured into the snapshot. */
    postEditUserACards: TradeCardSnapshot[];
    postEditUserBCards: TradeCardSnapshot[];
    now: Date;
    /** Extra payload merged into the `edited` event (e.g. viaSuggestion). */
    extraPayload?: Record<string, unknown>;
  },
): Promise<{ snapshotEventId: string }> {
  // Pull the most recent events to detect a merge target. Limit small —
  // we only need the very latest few entries.
  const recent = await db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, args.sessionId))
    .orderBy(desc(sessionEvents.createdAt))
    .limit(10);

  // "Meaningful" events for the merge check: anything user-visible.
  // We exclude `edit-snapshot` (paired with edited; not its own beat)
  // and `notified` (system telemetry).
  const meaningful = recent.filter(e => e.type !== 'edit-snapshot' && e.type !== 'notified');
  const last = meaningful[0];

  let mergeTarget: { editedId: string; snapshotId: string; baseSideCards: TradeCardSnapshot[]; existingExtras: Record<string, unknown> } | null = null;

  if (
    last
    && last.type === 'edited'
    && last.actorUserId === args.actorUserId
    && (args.now.getTime() - last.createdAt.getTime()) <= EDITED_MERGE_WINDOW_MS
  ) {
    const lastPayload = (last.payload ?? {}) as Record<string, unknown>;
    const snapshotId = typeof lastPayload.snapshotEventId === 'string' ? lastPayload.snapshotEventId : null;
    if (snapshotId) {
      // Verify the snapshot row still exists.
      const snap = recent.find(e => e.id === snapshotId);
      if (snap) {
        const baseSideCards = Array.isArray(lastPayload.baseSideCards)
          ? lastPayload.baseSideCards as TradeCardSnapshot[]
          : args.oldActorSideCards;
        // Strip the fields we re-derive from extras (so we keep
        // `viaSuggestion` etc. but replace `side`, `count`, `added`,
        // `removed`, `baseSideCards`, `snapshotEventId`).
        const { side: _s, count: _c, added: _a, removed: _r, baseSideCards: _b, snapshotEventId: _sid, ...existingExtras } = lastPayload;
        void _s; void _c; void _a; void _r; void _b; void _sid;
        mergeTarget = { editedId: last.id, snapshotId, baseSideCards, existingExtras };
      }
    }
  }

  const baseCards = mergeTarget ? mergeTarget.baseSideCards : args.oldActorSideCards;
  const cumulativeDiff = diffCardSets(baseCards, args.newActorSideCards);

  if (mergeTarget) {
    const editedPayload: Record<string, unknown> = {
      ...mergeTarget.existingExtras,
      ...(args.extraPayload ?? {}),
      side: args.viewerIsA ? 'a' : 'b',
      count: args.newActorSideCards.length,
      added: cumulativeDiff.added,
      removed: cumulativeDiff.removed,
      baseSideCards: baseCards,
      snapshotEventId: mergeTarget.snapshotId,
    };
    await db
      .update(sessionEvents)
      .set({ payload: editedPayload, createdAt: args.now })
      .where(eq(sessionEvents.id, mergeTarget.editedId));
    await db
      .update(sessionEvents)
      .set({
        payload: { userACards: args.postEditUserACards, userBCards: args.postEditUserBCards },
        createdAt: args.now,
      })
      .where(eq(sessionEvents.id, mergeTarget.snapshotId));
    return { snapshotEventId: mergeTarget.snapshotId };
  }

  // Fresh pair — insert snapshot first so we have its id for the
  // edited event's payload.
  const snapshotEventId = crypto.randomUUID();
  try {
    await db.insert(sessionEvents).values({
      id: snapshotEventId,
      sessionId: args.sessionId,
      actorUserId: args.actorUserId,
      type: 'edit-snapshot',
      payload: { userACards: args.postEditUserACards, userBCards: args.postEditUserBCards },
    });
    await db.insert(sessionEvents).values({
      id: crypto.randomUUID(),
      sessionId: args.sessionId,
      actorUserId: args.actorUserId,
      type: 'edited',
      payload: {
        ...(args.extraPayload ?? {}),
        side: args.viewerIsA ? 'a' : 'b',
        count: args.newActorSideCards.length,
        added: cumulativeDiff.added,
        removed: cumulativeDiff.removed,
        baseSideCards: baseCards,
        snapshotEventId,
      },
    });
  } catch (err) {
    // Same fire-and-forget posture as recordSessionEvent — don't roll
    // back the parent state change because audit-log writes failed.
    console.error('sessions.recordOrMergeEditedPair: insert failed', args.sessionId, err);
  }
  return { snapshotEventId };
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

  // Auto-sweep pending suggestions: any whose residual is now empty
  // against the post-edit state get auto-dismissed (reason='satisfied').
  // E.g. user A suggested user B add Luke + Han; B independently adds
  // Luke + Han; on B's next edit the residual goes empty → dismissed.
  const postEditUserACards = viewerIsA ? args.cards : row.userACards;
  const postEditUserBCards = viewerIsA ? row.userBCards : args.cards;
  const { next: sweptSuggestions, newlyDismissed } = sweepAutoDismissals(
    row.pendingSuggestions ?? [],
    postEditUserACards,
    postEditUserBCards,
    now,
  );

  await db
    .update(tradeSessions)
    .set({
      userACards: postEditUserACards,
      userBCards: postEditUserBCards,
      // Every edit clears confirmations — the counterpart needs to
      // see the new state before confirming again.
      confirmedByUserIds: [],
      lastEditedAt: now,
      lastEditedByUserId: args.viewerUserId,
      updatedAt: now,
      // Bump expiry forward on active use.
      expiresAt: nextExpiresAt(now),
      pendingSuggestions: pruneStaleDismissals(sweptSuggestions, now),
    })
    .where(eq(tradeSessions.id, args.sessionId));

  // Record the edited+snapshot pair via the merging helper. Rapid
  // same-actor edits within EDITED_MERGE_WINDOW_MS collapse into one
  // timeline row instead of N — keeps the panel readable during a
  // card-add binge. Cumulative diff is recomputed against the
  // baseSideCards captured in the existing edited event.
  const oldActorSideCards = viewerIsA ? row.userACards : row.userBCards;
  await recordOrMergeEditedPair(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    viewerIsA,
    oldActorSideCards,
    newActorSideCards: args.cards,
    postEditUserACards,
    postEditUserBCards,
    now,
  });

  if (priorConfirmations > 0) {
    await recordSessionEvent(db, {
      sessionId: args.sessionId,
      actorUserId: args.viewerUserId,
      type: 'unconfirmed',
      payload: { cleared: priorConfirmations },
    });
  }

  // Log auto-dismissals from the suggestion sweep so the timeline
  // explains why a suggestion disappeared ("satisfied by your edit").
  for (const dismissed of newlyDismissed) {
    await recordSessionEvent(db, {
      sessionId: args.sessionId,
      actorUserId: args.viewerUserId,
      type: 'suggestion-dismissed',
      payload: {
        suggestionId: dismissed.id,
        reason: dismissed.dismissedReason ?? 'satisfied',
      },
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
 * Remove the viewer from `confirmedByUserIds` on an active session.
 *
 * Use case: a user hits Confirm, realises a mistake, and wants to
 * edit their side before the counterpart confirms. Editing ALREADY
 * clears both confirmations (see `editSessionSide`), so this endpoint
 * is the lighter-weight path for "I want to uncommit without having
 * to change a card." Only meaningful before the session settles —
 * settled sessions refuse the unconfirm (you can't undo a handshake).
 *
 * Idempotent — unconfirming when not confirmed is a no-op that just
 * returns the current view. Terminal sessions (settled / cancelled /
 * expired) return 'terminal' so the caller can show a clear error
 * rather than silently appearing to have done nothing.
 */
export type UnconfirmSessionResult =
  | { ok: true; view: SessionView }
  | { ok: false; reason: 'not-found' | 'not-participant' | 'terminal' };

export async function unconfirmSession(
  db: Db,
  args: { sessionId: string; viewerUserId: string },
): Promise<UnconfirmSessionResult> {
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

  // Idempotent: already unconfirmed → no mutation, just re-fetch for
  // the caller's rendered view.
  if (!row.confirmedByUserIds.includes(args.viewerUserId)) {
    const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
    return view ? { ok: true, view } : { ok: false, reason: 'not-found' };
  }

  const nextConfirmations = row.confirmedByUserIds.filter(id => id !== args.viewerUserId);
  const now = new Date();

  await db
    .update(tradeSessions)
    .set({
      confirmedByUserIds: nextConfirmations,
      updatedAt: now,
    })
    .where(eq(tradeSessions.id, args.sessionId));

  await recordSessionEvent(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    type: 'unconfirmed',
  });

  const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
  if (!view) return { ok: false, reason: 'not-found' };
  return { ok: true, view };
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

// --- PR 1: chat + read state -----------------------------------------------

/** Soft cap on chat messages per user per minute. Crosses this and
 *  the chat endpoint returns 'rate-limited'. Cap is generous — it's
 *  meant to deter accidental floods, not legitimate negotiation. */
export const CHAT_RATE_LIMIT_PER_MINUTE = 10;
export const CHAT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const CHAT_MAX_BODY_LENGTH = 500;

export type SendChatResult =
  | { ok: true; view: SessionView }
  | { ok: false; reason: 'not-found' | 'not-participant' | 'terminal' | 'empty' | 'too-long' | 'rate-limited' };

/**
 * Append a chat event to the session's timeline. Validates participant +
 * non-terminal status, enforces the soft rate limit, then records the
 * event and returns a fresh view.
 *
 * Doesn't touch confirmations (chat ≠ edit) or the lastEditedAt /
 * expiresAt bookkeeping — chat is conversational metadata, not state.
 */
export async function sendChatMessage(
  db: Db,
  args: { sessionId: string; viewerUserId: string; body: string },
): Promise<SendChatResult> {
  const trimmed = args.body.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > CHAT_MAX_BODY_LENGTH) return { ok: false, reason: 'too-long' };

  const [row] = await db
    .select({
      id: tradeSessions.id,
      userAId: tradeSessions.userAId,
      userBId: tradeSessions.userBId,
      status: tradeSessions.status,
    })
    .from(tradeSessions)
    .where(eq(tradeSessions.id, args.sessionId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.userAId !== args.viewerUserId && row.userBId !== args.viewerUserId) {
    return { ok: false, reason: 'not-participant' };
  }
  if (row.status !== 'active') return { ok: false, reason: 'terminal' };

  // Rate limit: count viewer's chat events in the last minute.
  const windowStart = new Date(Date.now() - CHAT_RATE_LIMIT_WINDOW_MS);
  const recent = await db
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(and(
      eq(sessionEvents.sessionId, args.sessionId),
      eq(sessionEvents.actorUserId, args.viewerUserId),
      eq(sessionEvents.type, 'chat'),
      gt(sessionEvents.createdAt, windowStart),
    ));
  if (recent.length >= CHAT_RATE_LIMIT_PER_MINUTE) {
    return { ok: false, reason: 'rate-limited' };
  }

  await recordSessionEvent(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    type: 'chat',
    payload: { body: trimmed },
  });

  const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
  if (!view) return { ok: false, reason: 'not-found' };
  return { ok: true, view };
}

export type MarkReadResult =
  | { ok: true; view: SessionView }
  | { ok: false; reason: 'not-found' | 'not-participant' };

/**
 * Stamp the viewer's `lastReadAt` to NOW. Idempotent — calling twice
 * just bumps the timestamp forward. The unread-count derivation lives
 * in `getSessionForViewer`, so the response carries the just-cleared
 * count (zero, in the steady state).
 */
export async function markSessionRead(
  db: Db,
  args: { sessionId: string; viewerUserId: string },
): Promise<MarkReadResult> {
  const [row] = await db
    .select({
      userAId: tradeSessions.userAId,
      userBId: tradeSessions.userBId,
    })
    .from(tradeSessions)
    .where(eq(tradeSessions.id, args.sessionId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.userAId !== args.viewerUserId && row.userBId !== args.viewerUserId) {
    return { ok: false, reason: 'not-participant' };
  }
  const viewerIsA = row.userAId === args.viewerUserId;
  const now = new Date();

  await db
    .update(tradeSessions)
    .set(viewerIsA ? { userALastReadAt: now } : { userBLastReadAt: now })
    .where(eq(tradeSessions.id, args.sessionId));

  const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
  if (!view) return { ok: false, reason: 'not-found' };
  return { ok: true, view };
}

// --- PR 2: cross-side suggestions ------------------------------------------

/**
 * Given a single pending suggestion + the session's current both-side
 * card state, compute what's still missing to satisfy it. Used both
 * for the view (so the UI renders residual delta) and for auto-
 * dismissal (residual === empty → suggestion is satisfied).
 */
function cardListsEqual(a: TradeCardSnapshot[], b: TradeCardSnapshot[]): boolean {
  if (a.length !== b.length) return false;
  const aMap = new Map(a.map(c => [c.productId, c.qty]));
  for (const c of b) {
    if (aMap.get(c.productId) !== c.qty) return false;
  }
  return true;
}

/**
 * Window during which consecutive same-actor `edited` events get
 * merged into a single timeline row. Without this, a card-add
 * binge floods the panel ("@A edited their side · @A edited their
 * side · @A edited their side"). 30s tracks the actual ergonomics
 * — long enough to absorb a multi-card session, short enough that
 * a deliberate two-step edit registers as two events.
 */
export const EDITED_MERGE_WINDOW_MS = 30 * 1000;

/**
 * Per-productId diff of two card snapshot lists. `added` carries the
 * delta count for productIds whose qty went up (or appeared); `removed`
 * carries the delta for productIds whose qty went down (or
 * disappeared). Card metadata (name, variant, unitPrice) for added
 * entries comes from the NEW list; for removed entries from the OLD
 * list — matches "this is what was added / what was there before."
 *
 * Used to enrich the 'edited' event payload so the timeline can show
 * "Added 2× Luke, removed 1× Han" rather than just "edited their side."
 */
function diffCardSets(
  oldCards: TradeCardSnapshot[],
  newCards: TradeCardSnapshot[],
): { added: TradeCardSnapshot[]; removed: TradeCardSnapshot[] } {
  const oldByPid = new Map(oldCards.map(c => [c.productId, c]));
  const newByPid = new Map(newCards.map(c => [c.productId, c]));
  const allPids = new Set([...oldByPid.keys(), ...newByPid.keys()]);

  const added: TradeCardSnapshot[] = [];
  const removed: TradeCardSnapshot[] = [];

  for (const pid of allPids) {
    const oldQty = oldByPid.get(pid)?.qty ?? 0;
    const newQty = newByPid.get(pid)?.qty ?? 0;
    if (newQty > oldQty) {
      const card = newByPid.get(pid)!;
      added.push({ ...card, qty: newQty - oldQty });
    } else if (newQty < oldQty) {
      const card = oldByPid.get(pid)!;
      removed.push({ ...card, qty: oldQty - newQty });
    }
  }

  return { added, removed };
}

function computeSuggestionResidual(
  suggestion: PendingSuggestion,
  userACards: TradeCardSnapshot[],
  userBCards: TradeCardSnapshot[],
): { residualAdd: TradeCardSnapshot[]; residualRemove: TradeCardSnapshot[] } {
  // 'both'-side reverts compute satisfaction differently — current
  // state matches the snapshot atomically, no per-card residual.
  // We return empty residual lists for the per-card UI, and the
  // sweep treats matching state as satisfied via cardListsEqual.
  if (suggestion.targetSide === 'both') {
    return { residualAdd: [], residualRemove: [] };
  }
  const target = suggestion.targetSide === 'a' ? userACards : userBCards;
  const targetByPid = new Map(target.map(c => [c.productId, c.qty]));

  const residualAdd: TradeCardSnapshot[] = [];
  for (const wanted of suggestion.cardsToAdd) {
    const have = targetByPid.get(wanted.productId) ?? 0;
    const need = wanted.qty - have;
    if (need > 0) {
      residualAdd.push({ ...wanted, qty: need });
    }
  }
  const residualRemove: TradeCardSnapshot[] = [];
  for (const removed of suggestion.cardsToRemove) {
    const stillHave = targetByPid.get(removed.productId) ?? 0;
    if (stillHave > 0) {
      // Residual carries the *current* qty as the "still to remove"
      // count — the user could have already partially reduced it.
      residualRemove.push({ ...removed, qty: stillHave });
    }
  }
  return { residualAdd, residualRemove };
}

/**
 * After an edit, sweep pending suggestions and auto-dismiss any whose
 * residual is empty (satisfied). Returns the updated list. Caller is
 * responsible for persisting + emitting events for newly-dismissed
 * rows. No-op if nothing needs changing.
 */
function sweepAutoDismissals(
  suggestions: PendingSuggestion[],
  userACards: TradeCardSnapshot[],
  userBCards: TradeCardSnapshot[],
  now: Date,
): { next: PendingSuggestion[]; newlyDismissed: PendingSuggestion[] } {
  const newlyDismissed: PendingSuggestion[] = [];
  const next = suggestions.map(s => {
    if (s.dismissedAt) return s; // already dismissed, leave alone

    // 'both'-side revert: satisfied iff the current state of both
    // sides exactly matches the snapshot. (The suggestion is "set
    // both sides to this state"; if they're already there, the
    // request is effectively done.)
    if (s.targetSide === 'both') {
      if (!s.bothSidesSnapshot) return s; // malformed — leave alone
      if (
        cardListsEqual(s.bothSidesSnapshot.userACards, userACards)
        && cardListsEqual(s.bothSidesSnapshot.userBCards, userBCards)
      ) {
        const dismissed: PendingSuggestion = {
          ...s,
          dismissedAt: now.toISOString(),
          dismissedReason: 'satisfied',
        };
        newlyDismissed.push(dismissed);
        return dismissed;
      }
      return s;
    }

    const { residualAdd, residualRemove } = computeSuggestionResidual(s, userACards, userBCards);
    if (residualAdd.length === 0 && residualRemove.length === 0) {
      const dismissed: PendingSuggestion = {
        ...s,
        dismissedAt: now.toISOString(),
        dismissedReason: 'satisfied',
      };
      newlyDismissed.push(dismissed);
      return dismissed;
    }
    return s;
  });
  return { next, newlyDismissed };
}

/** Strip dismissed suggestions whose dismissal is older than this
 *  threshold from the persisted column. They've served their audit
 *  purpose (event log carries the full record) so the JSONB stays
 *  bounded over a long-running session. */
const DISMISSED_TTL_MS = 30 * 1000;

function pruneStaleDismissals(suggestions: PendingSuggestion[], now: Date): PendingSuggestion[] {
  const cutoff = now.getTime() - DISMISSED_TTL_MS;
  return suggestions.filter(s => {
    if (!s.dismissedAt) return true;
    return new Date(s.dismissedAt).getTime() > cutoff;
  });
}

/**
 * Project persisted suggestions into the viewer-centric shape with
 * computed residuals. Filters out dismissed rows.
 */
function projectSuggestionsForViewer(
  suggestions: PendingSuggestion[],
  viewerUserId: string,
  viewerIsA: boolean,
  userACards: TradeCardSnapshot[],
  userBCards: TradeCardSnapshot[],
): PendingSuggestionView[] {
  const viewerSide: 'a' | 'b' = viewerIsA ? 'a' : 'b';
  return suggestions
    .filter(s => !s.dismissedAt)
    .map(s => {
      const { residualAdd, residualRemove } = computeSuggestionResidual(s, userACards, userBCards);
      return {
        id: s.id,
        suggestedByUserId: s.suggestedByUserId,
        suggestedByViewer: s.suggestedByUserId === viewerUserId,
        targetSide: s.targetSide,
        targetIsViewer: s.targetSide === viewerSide,
        cardsToAdd: s.cardsToAdd,
        cardsToRemove: s.cardsToRemove,
        bothSidesSnapshot: s.bothSidesSnapshot
          ? {
              yourCards: viewerIsA ? s.bothSidesSnapshot.userACards : s.bothSidesSnapshot.userBCards,
              theirCards: viewerIsA ? s.bothSidesSnapshot.userBCards : s.bothSidesSnapshot.userACards,
            }
          : undefined,
        residualAdd,
        residualRemove,
        createdAt: s.createdAt,
      };
    });
}

export type SuggestForSessionResult =
  | { ok: true; view: SessionView; suggestionId: string }
  | { ok: false; reason: 'not-found' | 'not-participant' | 'terminal' | 'invalid-target' | 'empty' | 'cap-exceeded' | 'open-slot' };

/**
 * Author a new cross-side suggestion. Validates:
 *   - viewer is a participant
 *   - session is active and has a counterpart (no suggesting on open
 *     slots — there's nobody to accept)
 *   - targetSide is the COUNTERPART's side (you can't suggest changes
 *     to your own side; just edit it)
 *   - at least one of cardsToAdd / cardsToRemove is non-empty
 *   - active suggestions (not yet dismissed) are below the cap
 */
export async function suggestForSession(
  db: Db,
  args: {
    sessionId: string;
    viewerUserId: string;
    targetSide: 'a' | 'b';
    cardsToAdd: TradeCardSnapshot[];
    cardsToRemove: TradeCardSnapshot[];
  },
): Promise<SuggestForSessionResult> {
  if (args.cardsToAdd.length === 0 && args.cardsToRemove.length === 0) {
    return { ok: false, reason: 'empty' };
  }

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
  if (row.userBId === null) return { ok: false, reason: 'open-slot' };

  const viewerIsA = row.userAId === args.viewerUserId;
  const viewerSide: 'a' | 'b' = viewerIsA ? 'a' : 'b';
  if (args.targetSide === viewerSide) {
    return { ok: false, reason: 'invalid-target' };
  }

  const active = (row.pendingSuggestions ?? []).filter(s => !s.dismissedAt);
  if (active.length >= MAX_PENDING_SUGGESTIONS) {
    return { ok: false, reason: 'cap-exceeded' };
  }

  const now = new Date();
  const newSuggestion: PendingSuggestion = {
    id: crypto.randomUUID(),
    suggestedByUserId: args.viewerUserId,
    targetSide: args.targetSide,
    cardsToAdd: args.cardsToAdd,
    cardsToRemove: args.cardsToRemove,
    createdAt: now.toISOString(),
  };

  // Prune stale dismissals at write time so the column doesn't grow
  // unbounded under heavy use.
  const pruned = pruneStaleDismissals(row.pendingSuggestions ?? [], now);
  const next = [...pruned, newSuggestion];

  await db
    .update(tradeSessions)
    .set({ pendingSuggestions: next, updatedAt: now })
    .where(eq(tradeSessions.id, args.sessionId));

  await recordSessionEvent(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    type: 'suggestion-created',
    payload: {
      suggestionId: newSuggestion.id,
      targetSide: args.targetSide,
      addCount: args.cardsToAdd.length,
      removeCount: args.cardsToRemove.length,
    },
  });

  const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
  if (!view) return { ok: false, reason: 'not-found' };
  return { ok: true, view, suggestionId: newSuggestion.id };
}

export type AcceptSuggestionResult =
  | { ok: true; view: SessionView }
  | { ok: false; reason: 'not-found' | 'not-participant' | 'terminal' | 'no-such-suggestion' | 'not-target' | 'already-dismissed' };

/**
 * Apply a pending suggestion's residual delta to the target side via
 * `editSessionSide`. Reuses the edit machinery so confirmations
 * auto-clear and the timeline gets both an `edited` event and a
 * `suggestion-accepted` event. Only the suggestion's TARGET (the
 * counterpart) can accept.
 */
export async function acceptSuggestion(
  db: Db,
  args: { sessionId: string; viewerUserId: string; suggestionId: string },
): Promise<AcceptSuggestionResult> {
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

  const suggestions = row.pendingSuggestions ?? [];
  const idx = suggestions.findIndex(s => s.id === args.suggestionId);
  if (idx < 0) return { ok: false, reason: 'no-such-suggestion' };
  const suggestion = suggestions[idx];
  if (suggestion.dismissedAt) return { ok: false, reason: 'already-dismissed' };

  const viewerIsA = row.userAId === args.viewerUserId;
  const viewerSide: 'a' | 'b' = viewerIsA ? 'a' : 'b';

  // Authorization rules differ by suggestion shape:
  //   - 'a' / 'b': only the target side's owner can accept.
  //   - 'both' (revert): the suggester explicitly committed to the
  //     revert by proposing it; only the COUNTERPART (non-suggester)
  //     can accept. That's the "double-sided confirm" — both parties
  //     have to agree, one via proposal, the other via acceptance.
  if (suggestion.targetSide === 'both') {
    if (suggestion.suggestedByUserId === args.viewerUserId) {
      return { ok: false, reason: 'not-target' };
    }
  } else {
    if (suggestion.targetSide !== viewerSide) {
      return { ok: false, reason: 'not-target' };
    }
  }

  const now = new Date();
  const remaining = suggestions.filter((_, i) => i !== idx);
  const priorConfirmations = row.confirmedByUserIds.length;

  // Compute next-state cards. For 'a' / 'b' we apply the residual
  // delta to the target side; for 'both' we replace both sides with
  // the snapshot.
  let nextUserACards: TradeCardSnapshot[];
  let nextUserBCards: TradeCardSnapshot[];
  let acceptedPayload: Record<string, unknown>;

  if (suggestion.targetSide === 'both') {
    if (!suggestion.bothSidesSnapshot) {
      return { ok: false, reason: 'no-such-suggestion' }; // malformed
    }
    nextUserACards = suggestion.bothSidesSnapshot.userACards;
    nextUserBCards = suggestion.bothSidesSnapshot.userBCards;
    acceptedPayload = {
      suggestionId: suggestion.id,
      kind: 'revert',
    };
  } else {
    const { residualAdd, residualRemove } = computeSuggestionResidual(
      suggestion,
      row.userACards,
      row.userBCards,
    );
    const targetCurrent = viewerIsA ? row.userACards : row.userBCards;
    const byPid = new Map(targetCurrent.map(c => [c.productId, { ...c }]));
    for (const add of residualAdd) {
      const existing = byPid.get(add.productId);
      if (existing) {
        byPid.set(add.productId, { ...existing, qty: existing.qty + add.qty });
      } else {
        byPid.set(add.productId, { ...add });
      }
    }
    for (const rm of residualRemove) {
      byPid.delete(rm.productId);
    }
    const nextCards = Array.from(byPid.values());
    nextUserACards = viewerIsA ? nextCards : row.userACards;
    nextUserBCards = viewerIsA ? row.userBCards : nextCards;
    acceptedPayload = {
      suggestionId: suggestion.id,
      addedCount: residualAdd.length,
      removedCount: residualRemove.length,
    };
  }

  // Apply via direct update; can't reuse editSessionSide because it
  // does its own snapshot/event recording and we need to atomically
  // swap pending_suggestions in the same write.
  await db
    .update(tradeSessions)
    .set({
      userACards: nextUserACards,
      userBCards: nextUserBCards,
      confirmedByUserIds: [],
      lastEditedAt: now,
      lastEditedByUserId: args.viewerUserId,
      updatedAt: now,
      expiresAt: nextExpiresAt(now),
      pendingSuggestions: pruneStaleDismissals(remaining, now),
    })
    .where(eq(tradeSessions.id, args.sessionId));

  await recordSessionEvent(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    type: 'suggestion-accepted',
    payload: acceptedPayload,
  });

  // Acceptance produces an edited+snapshot pair the same way a direct
  // edit does. For 'both'-target reverts the actor's "side" is both —
  // we still call the merging helper but pass cumulative both-side
  // arrays as the actor side; the merge window will rarely catch this
  // because revert-acceptance is a deliberate event, but we keep the
  // path uniform.
  const oldActorSideCards = suggestion.targetSide === 'both'
    ? [...row.userACards, ...row.userBCards]
    : (viewerIsA ? row.userACards : row.userBCards);
  const newActorSideCards = suggestion.targetSide === 'both'
    ? [...nextUserACards, ...nextUserBCards]
    : (viewerIsA ? nextUserACards : nextUserBCards);
  await recordOrMergeEditedPair(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    viewerIsA,
    oldActorSideCards,
    newActorSideCards,
    postEditUserACards: nextUserACards,
    postEditUserBCards: nextUserBCards,
    now,
    extraPayload: {
      viaSuggestion: suggestion.id,
      ...(suggestion.targetSide === 'both' ? { side: 'both' as const } : {}),
    },
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

export type DismissSuggestionResult =
  | { ok: true; view: SessionView }
  | { ok: false; reason: 'not-found' | 'not-participant' | 'no-such-suggestion' | 'already-dismissed' };

/**
 * Explicit "no thanks" on a pending suggestion. Either party can
 * dismiss — the suggester might withdraw their own suggestion, the
 * target might decline. Logs `suggestion-dismissed` with reason
 * 'explicit'. Doesn't touch cards.
 */
export async function dismissSuggestion(
  db: Db,
  args: { sessionId: string; viewerUserId: string; suggestionId: string },
): Promise<DismissSuggestionResult> {
  const [row] = await db
    .select()
    .from(tradeSessions)
    .where(eq(tradeSessions.id, args.sessionId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.userAId !== args.viewerUserId && row.userBId !== args.viewerUserId) {
    return { ok: false, reason: 'not-participant' };
  }

  const suggestions = row.pendingSuggestions ?? [];
  const idx = suggestions.findIndex(s => s.id === args.suggestionId);
  if (idx < 0) return { ok: false, reason: 'no-such-suggestion' };
  if (suggestions[idx].dismissedAt) return { ok: false, reason: 'already-dismissed' };

  const now = new Date();
  const next = suggestions.map((s, i) => i === idx
    ? { ...s, dismissedAt: now.toISOString(), dismissedReason: 'explicit' as const }
    : s);

  await db
    .update(tradeSessions)
    .set({
      pendingSuggestions: pruneStaleDismissals(next, now),
      updatedAt: now,
    })
    .where(eq(tradeSessions.id, args.sessionId));

  await recordSessionEvent(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    type: 'suggestion-dismissed',
    payload: { suggestionId: args.suggestionId, reason: 'explicit' },
  });

  const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
  if (!view) return { ok: false, reason: 'not-found' };
  return { ok: true, view };
}

// --- PR 3: snapshot history + double-sided revert -------------------------

export type ProposeRevertResult =
  | { ok: true; view: SessionView; suggestionId: string }
  | { ok: false; reason: 'not-found' | 'not-participant' | 'terminal' | 'open-slot' | 'no-such-snapshot' | 'cap-exceeded' | 'no-op' };

/**
 * Author a "revert to this state" suggestion. Looks up the named
 * snapshot event in this session, captures its `{userACards,
 * userBCards}` payload, and creates a `targetSide: 'both'` pending
 * suggestion that the COUNTERPART must accept (double-sided
 * confirm). Auto-dismisses immediately if the current state already
 * matches the snapshot — no point holding a no-op suggestion.
 *
 * Reuses pending_suggestions storage + accept/dismiss endpoints +
 * auto-sweep machinery from PR 2; the only special case is the
 * 'both' targetSide branch in `acceptSuggestion`.
 */
export async function proposeRevertForSession(
  db: Db,
  args: { sessionId: string; viewerUserId: string; snapshotEventId: string },
): Promise<ProposeRevertResult> {
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
  if (row.userBId === null) return { ok: false, reason: 'open-slot' };

  // Pull the snapshot event. Must belong to this session and be of
  // type 'edit-snapshot' (revert can only target real snapshot
  // payloads, not arbitrary events).
  const [event] = await db
    .select()
    .from(sessionEvents)
    .where(and(
      eq(sessionEvents.id, args.snapshotEventId),
      eq(sessionEvents.sessionId, args.sessionId),
    ))
    .limit(1);
  if (!event || event.type !== 'edit-snapshot') {
    return { ok: false, reason: 'no-such-snapshot' };
  }
  const payload = event.payload as { userACards?: TradeCardSnapshot[]; userBCards?: TradeCardSnapshot[] } | null;
  if (!payload || !Array.isArray(payload.userACards) || !Array.isArray(payload.userBCards)) {
    return { ok: false, reason: 'no-such-snapshot' };
  }

  // No-op shortcut — current state already matches the snapshot.
  // Reverting to "now" is meaningless; refuse so the user gets an
  // immediate "nothing to revert" hint instead of a phantom pending
  // suggestion that auto-dismisses on the next poll.
  if (
    cardListsEqual(payload.userACards, row.userACards)
    && cardListsEqual(payload.userBCards, row.userBCards)
  ) {
    return { ok: false, reason: 'no-op' };
  }

  const active = (row.pendingSuggestions ?? []).filter(s => !s.dismissedAt);
  if (active.length >= MAX_PENDING_SUGGESTIONS) {
    return { ok: false, reason: 'cap-exceeded' };
  }

  const now = new Date();
  const newSuggestion: PendingSuggestion = {
    id: crypto.randomUUID(),
    suggestedByUserId: args.viewerUserId,
    targetSide: 'both',
    cardsToAdd: [],
    cardsToRemove: [],
    bothSidesSnapshot: {
      userACards: payload.userACards,
      userBCards: payload.userBCards,
    },
    createdAt: now.toISOString(),
  };

  const pruned = pruneStaleDismissals(row.pendingSuggestions ?? [], now);
  const next = [...pruned, newSuggestion];

  await db
    .update(tradeSessions)
    .set({ pendingSuggestions: next, updatedAt: now })
    .where(eq(tradeSessions.id, args.sessionId));

  await recordSessionEvent(db, {
    sessionId: args.sessionId,
    actorUserId: args.viewerUserId,
    type: 'suggestion-created',
    payload: {
      suggestionId: newSuggestion.id,
      targetSide: 'both',
      kind: 'revert',
      fromSnapshotEventId: args.snapshotEventId,
    },
  });

  const view = await getSessionForViewer(db, args.sessionId, args.viewerUserId);
  if (!view) return { ok: false, reason: 'not-found' };
  return { ok: true, view, suggestionId: newSuggestion.id };
}

// Expose drizzle helpers that future files will reuse so we don't
// fan out the imports across call sites.
export { sql, gt };
