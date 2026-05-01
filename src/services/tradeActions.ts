/**
 * Stateless POST helpers for proposal mutations. Shared between the
 * trade detail view and row-level actions on the history view so the
 * error handling + request shape stays consistent. Callers reflect the
 * result in their own local state (refresh list, patch detail, etc.);
 * these functions don't manage any UI state themselves.
 *
 * Result shape is discriminated so the UI can show the right message
 * without parsing error strings. `already-resolved` and `rate-limited`
 * are split out from the generic `error` bucket because they have
 * distinct UX (race-lost vs. cooldown).
 *
 * The actual HTTP machinery (status mapping, JSON serialization, the
 * try/catch around fetch) lives in `./apiClient.ts`. This file used to
 * carry its own duplicate `failure()` + `post()` — flagged by the
 * 2026-05-01 audit (refactor candidates #5) — but now delegates to
 * `apiPost` so there's one canonical mapping.
 */

import { apiPost } from './apiClient';

export type ActionFailureReason =
  | 'already-resolved'
  | 'rate-limited'
  | 'not-found'
  | 'forbidden'
  | 'unauthorized'
  | 'error';

export type ActionResult<T = Record<string, never>> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: ActionFailureReason;
      detail?: string;
      /** For `rate-limited` — ISO timestamp when the next attempt is
       *  allowed. Surfaced by Nudge's 24h cooldown. */
      nextAvailableAt?: string;
    };

// Query-param form (?action=X) works regardless of whether the
// `/api/trades/<x>` rewrite is wired up in vercel.json — the dispatcher
// reads `req.query.action` directly. Used uniformly here so the UI
// surface doesn't couple to the rewrite configuration.
export function cancelProposal(id: string): Promise<ActionResult> {
  return apiPost('/api/trades?action=cancel', { id });
}

export function acceptProposal(id: string): Promise<ActionResult<{ id: string; status: string }>> {
  return apiPost('/api/trades?action=accept', { id });
}

export function declineProposal(id: string): Promise<ActionResult<{ id: string; status: string }>> {
  return apiPost('/api/trades?action=decline', { id });
}

export function nudgeProposal(
  id: string,
  note?: string,
): Promise<ActionResult<{ id: string; nudgedAt: string }>> {
  return apiPost('/api/trades?action=nudge', note ? { id, note } : { id });
}

export function promoteProposalToShared(
  id: string,
): Promise<ActionResult<{ sessionId: string; created: boolean }>> {
  return apiPost('/api/trades?action=promote-to-shared', { proposalId: id });
}

export interface BulkResolveResult {
  id: string;
  outcome: 'ok' | 'already-resolved' | 'not-found' | 'forbidden';
}

export interface BulkResolveResponse {
  results: BulkResolveResult[];
  okCount: number;
  notificationsSent: number;
}

/**
 * Bulk decline or cancel. Server processes up to 50 ids in one request
 * and coalesces proposer-notification DMs (decline only) — essential
 * for side-stepping Discord's DM-channel-open rate limit (code 40003)
 * when a recipient clears a backlog of proposals.
 */
export function bulkResolveProposals(
  ids: string[],
  action: 'decline' | 'cancel',
): Promise<ActionResult<BulkResolveResponse>> {
  return apiPost('/api/trades?action=bulk-resolve', { ids, action });
}
