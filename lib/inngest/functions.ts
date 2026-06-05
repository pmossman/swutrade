import { inngest } from './client.js';

/**
 * Periodic sweep that DMs trade-session participants about unread
 * counterpart activity. Runs every 5 minutes via Inngest's scheduler.
 *
 * Why Inngest schedules instead of Vercel cron: Vercel Hobby caps
 * cron frequency at daily. We need a much tighter cadence to make
 * the DM-on-activity feel responsive. See `lib/inngest/client.ts`
 * for the full rationale.
 *
 * Re-enable: uncomment the `performSessionFollowupsSweep` call below
 * (and the import) once: (a) the sweep query is bounded to recent
 * activity instead of scanning every active session each tick, and
 * (b) the function swallows DB errors as a no-op so a Neon outage
 * doesn't turn into a retry storm again.
 *
 * TEMPORARILY NO-OP (2026-06-04): Neon hit its data-transfer quota
 * and started returning HTTP 402 on every query. The sweep threw,
 * Inngest auto-retried (default 4× with backoff), each retry burned
 * Vercel Active CPU — the function ran ~50×/hour instead of 12×/hour
 * for days, accumulating 17h+ of Active CPU across the month and
 * exceeding the free tier on Vercel too. Returning a no-op here
 * stops the retry chain at the source: Inngest sees success, never
 * retries, and each tick costs ~0 CPU instead of multiple seconds.
 */
export const sessionFollowupsCron = inngest.createFunction(
  {
    id: 'session-followups-cron',
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async () => {
    return { scanned: 0, dmd: 0, skipped: 0, errors: 0, disabled: true };
  },
);
