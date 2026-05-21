import type { VercelResponse } from '@vercel/node';

/**
 * Helpers for shaping HTTP responses so the client's apiClient can
 * narrow on the `code` field instead of pattern-matching human error
 * strings.
 *
 * Pass-1 (`src/services/sessionErrors.ts` + apiClient `domainErrors`)
 * wired the `{ error, code }` convention end-to-end for the `decline`
 * endpoint. Pass-2 lifts the convention to a single helper so the
 * remaining ~80 hand-rolled `res.status(X).json({ error: '...' })`
 * calls across api/sessions, api/me, etc. can adopt incrementally
 * as touched.
 *
 * Why a helper, not a router framework:
 * - The audit's anti-recommendation list is explicit that a routing
 *   framework would hide the 12-function Vercel ceiling that the
 *   dispatcher pattern is working around.
 * - This helper doesn't route. It just formats responses. The
 *   `?action=` dispatcher stays exactly as it is.
 * - Missing the `code` field in a new endpoint is now a type error
 *   (the helper's signature requires it), not a convention drift
 *   that goes unnoticed for months.
 */
export function replyDomainError(
  res: VercelResponse,
  opts: {
    /** HTTP status — typically 400, 403, 404, 409, 429. */
    status: number;
    /** Machine-readable tag. The client's `apiClient.domainErrors`
     *  enum lists the legal tags per endpoint family. */
    code: string;
    /** Human-readable message. Shown to users when no UI string
     *  override exists. */
    error: string;
    /** Optional extended detail for the message field. */
    detail?: string;
    /** For 429 rate-limit responses. */
    nextAvailableAt?: string;
  },
): VercelResponse {
  return res.status(opts.status).json({
    error: opts.error,
    code: opts.code,
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.nextAvailableAt ? { nextAvailableAt: opts.nextAvailableAt } : {}),
  });
}
