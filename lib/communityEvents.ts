/**
 * Append-only event log helpers for guild-scoped community activity.
 *
 * The Community 2.0 Overview tab reads from `community_events` via
 * `listEvents` below; lifecycle callers (proposal accept, guild
 * enrollment) fire-and-forget `recordEvent` to append.
 *
 * Privacy filter: events from actors with
 * `users.share_activity_publicly=false` are suppressed on read but
 * still recorded. Flipping the pref back on restores visibility of
 * the prior trail; we never lose history to a toggle.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from './db.js';
import {
  communityEvents,
  users,
  type CommunityEventType,
} from './schema.js';

type Db = ReturnType<typeof getDb>;

export interface RecordCommunityEventOptions {
  guildId: string;
  /** Who triggered the event. Null for system events (none defined
   *  today but reserved so callers don't have to special-case). */
  actorUserId: string | null;
  type: CommunityEventType;
  payload?: Record<string, unknown>;
}

export async function recordEvent(
  db: Db,
  opts: RecordCommunityEventOptions,
): Promise<void> {
  try {
    await db.insert(communityEvents).values({
      id: crypto.randomUUID(),
      guildId: opts.guildId,
      actorUserId: opts.actorUserId,
      type: opts.type,
      payload: opts.payload ?? null,
    });
  } catch (err) {
    // Audit-log loss, not correctness loss — don't roll back the
    // parent action over a telemetry insert hiccup.
    console.error(
      'communityEvents.recordEvent: insert failed',
      opts.type,
      opts.guildId,
      err,
    );
  }
}

export interface CommunityEventView {
  id: string;
  type: CommunityEventType;
  actor: {
    id: string;
    handle: string;
    username: string;
    avatarUrl: string | null;
  } | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * List recent events for a guild, newest → oldest.
 *
 * Caller should have already gated access (the viewer must be enrolled
 * + queryable in the guild); this helper doesn't re-check.
 *
 * Privacy filter: events from actors with `share_activity_publicly
 * =false` are excluded. Implemented in-join so we don't need a second
 * pass to drop them.
 */
export async function listEvents(
  db: Db,
  guildId: string,
  opts: { limit?: number } = {},
): Promise<CommunityEventView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  const rows = await db
    .select({
      id: communityEvents.id,
      type: communityEvents.type,
      payload: communityEvents.payload,
      createdAt: communityEvents.createdAt,
      actorId: users.id,
      actorHandle: users.handle,
      actorUsername: users.username,
      actorAvatarUrl: users.avatarUrl,
      actorShare: users.shareActivityPublicly,
    })
    .from(communityEvents)
    .leftJoin(users, eq(users.id, communityEvents.actorUserId))
    .where(and(
      eq(communityEvents.guildId, guildId),
      // Null actor (system event) passes through; otherwise require
      // the actor to still have sharing on. `.is(null).or(...)` via
      // raw sql because Drizzle's typed builder gets clunky with OR.
      sql`(${users.id} IS NULL OR ${users.shareActivityPublicly} = true)`,
    ))
    .orderBy(desc(communityEvents.createdAt))
    .limit(limit);

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

