/**
 * Session-followups sweep — periodic catch-up DM for unread
 * counterpart activity in active trade sessions.
 *
 * Runs in two paths today:
 *   1. Inngest scheduled function (`lib/inngest/functions.ts`) at
 *      every 5 min in production. The primary trigger.
 *   2. HTTP cron endpoint at `/api/cron/session-followups` (handled
 *      in `api/bot.ts::runSessionFollowupsSweep`) for manual
 *      debugging + as a fallback escape hatch.
 *
 * Pure domain logic lives here; both paths call into
 * `performSessionFollowupsSweep` directly with a shared deps shape.
 *
 * The sweep is idempotent — re-running on the same state is a no-op
 * (last_notified_at gates re-DMs). Inngest's at-least-once delivery
 * is fine here; a duplicate trigger is harmless.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from './db.js';
import { sessionEvents, tradeSessions, users } from './schema.js';
import { createDiscordBotClient, type DiscordBotClient } from './discordBot.js';
import { buildSessionActivityMessage } from './discordMessages.js';
import { recordSessionEvent } from './sessions.js';
import { reportError } from './errorReporter.js';

/**
 * Activity-relevant event types — these are the things a counterpart
 * does that the other participant should hear about. Excludes:
 *   - `created` (covered by the invite DM at session-create time)
 *   - `edit-snapshot` (internal bookkeeping)
 *   - `unconfirmed` (toggling Confirm off is too minor to ping)
 *   - `notified` (our own DM record)
 *   - `settled`/`cancelled`/`expired` (terminal — separate DM paths)
 */
export const ACTIVITY_EVENT_TYPES = [
  'chat',
  'edited',
  'confirmed',
  'suggestion-created',
  'suggestion-accepted',
  'suggestion-dismissed',
] as const;

export interface SessionFollowupsDeps {
  bot?: DiscordBotClient;
  /** Override for tests — the SWUTrade origin used in DM links. */
  appBaseUrl?: string;
  /** Test-scoping hook: when provided, only these session ids are
   *  scanned. Production callers omit this and the sweep walks every
   *  active session. The test DB is shared across CI runs and
   *  accumulates thousands of leftover active sessions; without this
   *  scope the per-test sweep iterates through all of them and hits
   *  the vitest timeout. */
  sessionIds?: string[];
}

export interface SessionFollowupsSweepResult {
  scanned: number;
  dmd: number;
  skipped: number;
  errors: number;
}

/**
 * Periodic sweep that catches up unread counterpart activity with a
 * single DM per recipient per session. Replaces the synchronous
 * cooldown-throttled DM that used to fire from `notifySessionActivity`
 * — same DM body, but with strictly simpler semantics:
 *
 *   for each active session, for each participant P:
 *     latestActivity = max(timestamp of counterpart-authored ACTIVITY_
 *       EVENT_TYPES events on this session)
 *     if latestActivity is newer than `lastReadAt[P]`
 *        AND newer than `last_notified_at[P]`
 *        AND P has `dmSessionActivity = true`
 *        AND P has a Discord id
 *     → DM P, stamp `last_notified_at[P] = now`, record a `notified` event.
 *
 * The scheduler interval IS the cooldown — running every 5 min means
 * at most one DM per session per recipient per 5 min. No 10-min
 * cooldown timer, no read-state-resets-cooldown gating, no
 * synchronous fire-then-debounce.
 *
 * Edge cases that just disappear:
 *   - Friend sent during a sync cooldown → next sweep picks it up.
 *   - Both closed, friend sent, friend closed → next sweep picks it up.
 *   - I closed mid-poll without firing markRead → cron looks at the
 *     server-side timestamps, doesn't care when the client fired
 *     markRead.
 */
export async function performSessionFollowupsSweep(
  deps: SessionFollowupsDeps = {},
): Promise<SessionFollowupsSweepResult> {
  const db = getDb();
  const bot = deps.bot ?? createDiscordBotClient();
  const appBaseUrl = deps.appBaseUrl
    ?? process.env.SWUTRADE_PUBLIC_URL
    ?? 'https://beta.swutrade.com';

  const sessionFilter = deps.sessionIds && deps.sessionIds.length > 0
    ? and(eq(tradeSessions.status, 'active'), inArray(tradeSessions.id, deps.sessionIds))
    : eq(tradeSessions.status, 'active');
  const activeSessions = await db
    .select({
      id: tradeSessions.id,
      userAId: tradeSessions.userAId,
      userBId: tradeSessions.userBId,
      userALastReadAt: tradeSessions.userALastReadAt,
      userBLastReadAt: tradeSessions.userBLastReadAt,
      lastNotifiedAt: tradeSessions.lastNotifiedAt,
    })
    .from(tradeSessions)
    .where(sessionFilter);

  let scanned = 0;
  let dmd = 0;
  let skipped = 0;
  let errors = 0;

  for (const session of activeSessions) {
    scanned += 1;
    if (!session.userBId) continue; // open-slot, no counterpart

    for (const recipientUserId of [session.userAId, session.userBId]) {
      const counterpartUserId = recipientUserId === session.userAId
        ? session.userBId
        : session.userAId;
      if (!recipientUserId || !counterpartUserId) continue;

      // Latest counterpart-authored activity event.
      const [latest] = await db
        .select({
          createdAt: sessionEvents.createdAt,
          type: sessionEvents.type,
        })
        .from(sessionEvents)
        .where(and(
          eq(sessionEvents.sessionId, session.id),
          eq(sessionEvents.actorUserId, counterpartUserId),
          // Cast through `readonly string[]` — drizzle's inArray
          // narrows to the column's enum literals which is more strict
          // than we need here.
          inArray(sessionEvents.type, ACTIVITY_EVENT_TYPES as unknown as readonly typeof ACTIVITY_EVENT_TYPES[number][]),
        ))
        .orderBy(desc(sessionEvents.createdAt))
        .limit(1);
      if (!latest) continue;
      const latestTs = latest.createdAt.getTime();

      // Already DM'd about this activity?
      const lastNotifiedRaw = session.lastNotifiedAt?.[recipientUserId];
      if (lastNotifiedRaw) {
        const lastNotifiedTs = Date.parse(lastNotifiedRaw);
        if (Number.isFinite(lastNotifiedTs) && lastNotifiedTs >= latestTs) {
          skipped += 1;
          continue;
        }
      }

      // Recipient has already read past this activity?
      const lastReadAt = recipientUserId === session.userAId
        ? session.userALastReadAt
        : session.userBLastReadAt;
      if (lastReadAt && lastReadAt.getTime() >= latestTs) {
        skipped += 1;
        continue;
      }

      // Recipient pref + Discord identity check.
      const [recipient] = await db
        .select({
          discordId: users.discordId,
          dmSessionActivity: users.dmSessionActivity,
        })
        .from(users)
        .where(eq(users.id, recipientUserId))
        .limit(1);
      if (!recipient?.discordId || !recipient.dmSessionActivity) {
        skipped += 1;
        continue;
      }

      // Counterpart handle for the DM body.
      const [counterpart] = await db
        .select({ handle: users.handle })
        .from(users)
        .where(eq(users.id, counterpartUserId))
        .limit(1);
      const counterpartHandle = counterpart?.handle ?? 'someone';

      const sessionUrl = `${appBaseUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(session.id)}`;
      const body = buildSessionActivityMessage({ counterpartHandle, sessionUrl });

      try {
        await bot.sendDirectMessage(recipient.discordId, body);
      } catch (err) {
        console.error('cron-session-followups: sendDirectMessage failed', session.id, recipientUserId, err);
        errors += 1;
        await reportError({
          source: 'bot.cron-session-followups.dm',
          tags: { sessionId: session.id, recipientUserId },
        }, err);
        continue;
      }

      // Stamp last_notified_at[P] BEFORE recording the event so a
      // mid-sweep crash doesn't leave us re-DMing on the next pass.
      const nextLastNotifiedAt: Record<string, string> = {
        ...(session.lastNotifiedAt ?? {}),
        [recipientUserId]: new Date().toISOString(),
      };
      await db.update(tradeSessions)
        .set({ lastNotifiedAt: nextLastNotifiedAt })
        .where(eq(tradeSessions.id, session.id));
      // Mutate locally so a second-participant iteration in the same
      // session (rare — both participants having unread activity from
      // each other) sees the fresh value.
      session.lastNotifiedAt = nextLastNotifiedAt;

      await recordSessionEvent(db, {
        sessionId: session.id,
        actorUserId: counterpartUserId,
        type: 'notified',
        payload: {
          kind: 'activity',
          recipientUserId,
        },
      });

      dmd += 1;
    }
  }

  return { scanned, dmd, skipped, errors };
}
