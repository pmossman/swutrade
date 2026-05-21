/**
 * Session lifecycle module.
 *
 * The state machine for `trade_sessions` rows. Two layers:
 *
 *   1. Pure rules (`isTerminal`, `isOpenSlot`, `nextStatus`,
 *      `sessionCapabilities`). No I/O. The FSM table lives here.
 *   2. DB-aware loaders (`loadActiveAsParticipant`,
 *      `loadAsParticipant`). The repeated select+guard preamble that
 *      every mutator in `lib/sessions.ts` used to inline.
 *
 * Mutators wrap their domain logic around the loaders so the four
 * universal failure modes — `not-found`, `not-participant`,
 * `terminal` — are named once and only once.
 *
 * A client-side projection (`src/utils/sessionCapabilities.ts`)
 * mirrors `sessionCapabilities`; a contract test in the integration
 * suite asserts the two stay in lockstep.
 */
import { eq } from 'drizzle-orm';
import type { getDb } from './db.js';
import { tradeSessions, type SessionStatus } from './schema.js';

type Db = ReturnType<typeof getDb>;
type TradeSessionRow = typeof tradeSessions.$inferSelect;

// ────────────────────────────────────────────────────────────────────
// Pure rules
// ────────────────────────────────────────────────────────────────────

/** Terminal statuses can never transition further. */
export function isTerminal(status: SessionStatus): boolean {
  return status !== 'active';
}

/**
 * A session is "open-slot" when it's active but has no counterpart
 * yet (the QR-handoff state). Only `claimOpenSlot` is meant to move
 * out of it; `confirmSession` allows confirming from this state but
 * can never settle from it (there's no counterpart to handshake).
 */
export function isOpenSlot(
  row: Pick<TradeSessionRow, 'status' | 'userBId'>,
): boolean {
  return row.status === 'active' && row.userBId === null;
}

/**
 * Compute the next status given the current status and a transition
 * input. Returns `null` if the action is illegal from the current
 * state — callers should have already filtered through one of the
 * loaders, so a `null` return from this function indicates a bug.
 *
 * Most actions keep the session active; only confirm-when-both-now-
 * confirmed transitions to `settled`, and cancel/decline transitions
 * to `cancelled`. The `expire` action is reserved for the sweep job.
 */
export type LifecycleAction =
  | { kind: 'edit' }
  | { kind: 'confirm'; bothNowConfirmed: boolean }
  | { kind: 'unconfirm' }
  | { kind: 'cancel' }
  | { kind: 'decline' }
  | { kind: 'expire' }
  | { kind: 'claim' }
  | { kind: 'suggest' }
  | { kind: 'accept-suggestion' }
  | { kind: 'dismiss-suggestion' }
  | { kind: 'propose-revert' }
  | { kind: 'send-chat' };

export function nextStatus(
  current: SessionStatus,
  action: LifecycleAction,
): SessionStatus | null {
  if (current !== 'active') return null;
  switch (action.kind) {
    case 'confirm':
      return action.bothNowConfirmed ? 'settled' : 'active';
    case 'cancel':
    case 'decline':
      return 'cancelled';
    case 'expire':
      return 'expired';
    default:
      return 'active';
  }
}

/**
 * Capability projection for the UI. Mirrors the server-side guards so
 * the SessionView CTAs can ask "what actions are legal right now?"
 * instead of re-deriving the FSM in each button's disabled prop.
 *
 * The client-side `src/utils/sessionCapabilities.ts` mirrors this
 * function over the wire-shape `SessionView`. A contract test in the
 * integration suite ties them together.
 */
export interface SessionCapabilities {
  canEdit: boolean;
  canConfirm: boolean;
  canUnconfirm: boolean;
  canCancel: boolean;
  canDecline: boolean;
  canSuggest: boolean;
  canChat: boolean;
}

export function sessionCapabilities(
  row: Pick<TradeSessionRow, 'status' | 'userBId' | 'confirmedByUserIds'>,
  viewerUserId: string,
): SessionCapabilities {
  if (isTerminal(row.status)) {
    return {
      canEdit: false,
      canConfirm: false,
      canUnconfirm: false,
      canCancel: false,
      canDecline: false,
      canSuggest: false,
      canChat: false,
    };
  }
  const hasCounterpart = row.userBId !== null;
  const viewerConfirmed = row.confirmedByUserIds.includes(viewerUserId);
  return {
    canEdit: true,
    // Confirming on an open-slot session is allowed (it pre-commits
    // the originator); the no-settle rule is enforced inside the
    // mutator via `bothNowConfirmed`.
    canConfirm: !viewerConfirmed,
    canUnconfirm: viewerConfirmed,
    canCancel: true,
    // Decline is only the right verb when there's a counterpart on
    // the other side — otherwise it's a withdraw, which maps to
    // cancel.
    canDecline: hasCounterpart,
    canSuggest: hasCounterpart,
    canChat: hasCounterpart,
  };
}

// ────────────────────────────────────────────────────────────────────
// DB-aware loaders
// ────────────────────────────────────────────────────────────────────

export type LoadFailure =
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'not-participant' }
  | { ok: false; reason: 'terminal' };

export type LoadSuccess = { ok: true; row: TradeSessionRow };

/**
 * Load a session row and assert: (a) it exists, (b) the viewer is
 * one of its participants, (c) it's still active. Returns the row on
 * success, or one of three typed failures.
 *
 * Used by every mutator in `lib/sessions.ts` that should refuse on
 * terminal sessions — `editSessionSide`, `confirmSession`,
 * `unconfirmSession`, `suggestForSession`, `acceptSuggestion`,
 * `dismissSuggestion`, `proposeRevertForSession`, `sendChatMessage`,
 * `declineSession`. Each used to open with the same 5-line preamble.
 */
export async function loadActiveAsParticipant(
  db: Db,
  args: { sessionId: string; viewerUserId: string },
): Promise<LoadSuccess | LoadFailure> {
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
  return { ok: true, row };
}

/**
 * Same loader minus the active-only check. Use this for idempotent
 * mutators (e.g. `cancelSession`) that want to return the current
 * view of a terminal session rather than erroring on it. The
 * `'terminal'` failure variant can't surface from this variant — it
 * returns the row regardless of status.
 */
export async function loadAsParticipant(
  db: Db,
  args: { sessionId: string; viewerUserId: string },
): Promise<LoadSuccess | Exclude<LoadFailure, { reason: 'terminal' }>> {
  const [row] = await db
    .select()
    .from(tradeSessions)
    .where(eq(tradeSessions.id, args.sessionId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.userAId !== args.viewerUserId && row.userBId !== args.viewerUserId) {
    return { ok: false, reason: 'not-participant' };
  }
  return { ok: true, row };
}
