/**
 * Inngest serve handler. The Inngest scheduler hits this endpoint
 * to introspect registered functions, sync changes after each
 * deploy, and dispatch scheduled / event-triggered runs.
 *
 * Path is `/api/inngest` by convention — Inngest's dashboard auto-
 * discovers functions by polling this URL after each deploy.
 *
 * Adapter: `inngest/express`. Inngest doesn't ship a dedicated
 * `inngest/vercel` adapter (only `inngest/next` for Next.js). The
 * express adapter expects the same Connect-style `(req, res)`
 * signature that Vercel Functions use, so it drops in cleanly.
 *
 * Auth flow: Inngest signs every incoming request with
 * `INNGEST_SIGNING_KEY`. The serve handler verifies the signature
 * before dispatching — no app-side auth check needed here.
 *
 * Adding a new Inngest function: declare it in `lib/inngest/functions.ts`
 * and add it to the `functions` array below. Inngest auto-syncs
 * on the next deploy ping.
 */

import { serve } from 'inngest/express';
import { inngest } from '../lib/inngest/client.js';
import { sessionFollowupsCron } from '../lib/inngest/functions.js';

export default serve({
  client: inngest,
  functions: [sessionFollowupsCron],
});
