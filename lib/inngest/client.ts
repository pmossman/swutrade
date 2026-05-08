import { Inngest } from 'inngest';

/**
 * Inngest client. Used by every function declared in `./functions.ts`
 * and by the serve handler at `api/inngest.ts`.
 *
 * `id` is the Inngest app id — it's the key Inngest uses to group
 * functions in their dashboard. Single-app for SWUTrade today;
 * splitting into multiple apps would require multiple serve handlers.
 *
 * Auth: `INNGEST_EVENT_KEY` (for sending events) and `INNGEST_SIGNING_KEY`
 * (for verifying incoming requests from Inngest's scheduler) are
 * picked up automatically from `process.env` by the SDK. Both are
 * set on Vercel's project settings; the dev / preview / production
 * environments can share keys (Inngest gates by environment via the
 * branch in their dashboard).
 *
 * Why Inngest over GitHub Actions cron + Vercel cron: app-feature
 * schedules belong on app infra, not CI. GH Actions for cron felt
 * like coupling app behaviour to release infrastructure; Vercel
 * Hobby caps cron frequency at daily. Inngest's free tier (50k
 * function runs/month) covers our needs ~6× over at the current
 * 5-min cadence (8.6k/month).
 */
export const inngest = new Inngest({
  id: 'swutrade',
});
