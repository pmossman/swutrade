import { inngest } from './client.js';
import { performSessionFollowupsSweep } from '../sessionFollowups.js';

/**
 * Periodic sweep that DMs trade-session participants about unread
 * counterpart activity. Runs every 5 minutes via Inngest's scheduler.
 *
 * Why Inngest schedules instead of Vercel cron: Vercel Hobby caps
 * cron frequency at daily. We need a much tighter cadence to make
 * the DM-on-activity feel responsive. See `lib/inngest/client.ts`
 * for the full rationale.
 *
 * The sweep itself is idempotent — re-running on the same state
 * is a no-op (last_notified_at gates re-DMs). Inngest's at-least-
 * once delivery is fine here; a duplicate trigger is harmless.
 *
 * The function calls `performSessionFollowupsSweep` directly (in-
 * process, no HTTP round-trip). That's the only invocation path
 * for the cron in production; the HTTP `/api/cron/session-followups`
 * endpoint is kept as a manual-trigger escape hatch but isn't on
 * any schedule.
 */
export const sessionFollowupsCron = inngest.createFunction(
  {
    id: 'session-followups-cron',
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async () => {
    return await performSessionFollowupsSweep();
  },
);
