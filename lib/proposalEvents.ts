/**
 * Append-only event log helpers for trade proposals.
 *
 * All proposal lifecycle state changes should call `recordEvent` so the
 * detail-view timeline stays honest. Writes are fire-and-forget from
 * the caller's perspective — a failed event insert shouldn't tank the
 * primary action (the proposal state change has already committed).
 */

import { and, asc, eq } from 'drizzle-orm';
import type { getDb } from './db.js';
import { proposalEvents, users, type ProposalEventType } from './schema.js';

type Db = ReturnType<typeof getDb>;

export interface RecordEventOptions {
  proposalId: string;
  /** The user who triggered the event. Null for system events
   *  (delivery transport, expiry cron). */
  actorUserId: string | null;
  type: ProposalEventType;
  /** Per-type free-form JSON bag. See `proposalEvents` schema comment
   *  for the canonical shapes. */
  payload?: Record<string, unknown>;
}

/**
 * Insert a single event row. Swallows + logs errors so a logging-layer
 * hiccup can't roll back the parent state transition.
 */
export async function recordEvent(db: Db, opts: RecordEventOptions): Promise<void> {
  try {
    await db.insert(proposalEvents).values({
      id: crypto.randomUUID(),
      proposalId: opts.proposalId,
      actorUserId: opts.actorUserId,
      type: opts.type,
      payload: opts.payload ?? null,
    });
  } catch (err) {
    // Don't use reportError here — the error reporter can itself call
    // through bot code, which could create recursive failure loops.
    // Console logging is enough for a diagnostic trail; the missing
    // event is an audit-log loss, not a correctness loss.
    console.error('recordEvent: failed to insert', opts.type, opts.proposalId, err);
  }
}

export interface ProposalEventView {
  id: string;
  type: ProposalEventType;
  actor: { id: string; handle: string; username: string; avatarUrl: string | null } | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * List all events for a proposal, oldest → newest. Joins actors so the
 * caller can render "@bob nudged this 2h ago" directly without a
 * follow-up user lookup. Returns plain JSON-serializable shapes for
 * direct API response use.
 */
export async function listEvents(db: Db, proposalId: string): Promise<ProposalEventView[]> {
  const rows = await db
    .select({
      id: proposalEvents.id,
      type: proposalEvents.type,
      payload: proposalEvents.payload,
      createdAt: proposalEvents.createdAt,
      actorId: users.id,
      actorHandle: users.handle,
      actorUsername: users.username,
      actorAvatarUrl: users.avatarUrl,
    })
    .from(proposalEvents)
    .leftJoin(users, eq(users.id, proposalEvents.actorUserId))
    .where(eq(proposalEvents.proposalId, proposalId))
    .orderBy(asc(proposalEvents.createdAt));

  return rows.map(r => ({
    id: r.id,
    type: r.type,
    actor: r.actorId
      ? {
          id: r.actorId,
          handle: r.actorHandle ?? '',
          username: r.actorUsername ?? '',
          avatarUrl: r.actorAvatarUrl,
        }
      : null,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Nudge rate-limit check — returns the timestamp of the most recent
 * `nudged` event for this proposal, or null if there hasn't been one.
 * The nudge endpoint uses this to enforce a 24h cooldown; caller
 * decides how to interpret the result.
 */
export async function lastNudgedAt(db: Db, proposalId: string): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: proposalEvents.createdAt })
    .from(proposalEvents)
    .where(and(eq(proposalEvents.proposalId, proposalId), eq(proposalEvents.type, 'nudged')))
    .orderBy(asc(proposalEvents.createdAt));
  if (rows.length === 0) return null;
  return rows[rows.length - 1].createdAt;
}
