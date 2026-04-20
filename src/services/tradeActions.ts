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
 */

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

function failure(
  status: number,
  body: Record<string, unknown> | null,
): Extract<ActionResult, { ok: false }> {
  const detail = typeof body?.detail === 'string' ? body.detail : undefined;
  if (status === 409) return { ok: false, reason: 'already-resolved', detail };
  if (status === 429) {
    const nextAvailableAt = typeof body?.nextAvailableAt === 'string' ? body.nextAvailableAt : undefined;
    return { ok: false, reason: 'rate-limited', detail, nextAvailableAt };
  }
  if (status === 404) return { ok: false, reason: 'not-found', detail };
  if (status === 403) return { ok: false, reason: 'forbidden', detail };
  if (status === 401) return { ok: false, reason: 'unauthorized', detail };
  return { ok: false, reason: 'error', detail };
}

async function post<T = Record<string, never>>(
  url: string,
  body: unknown,
): Promise<ActionResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) return failure(res.status, parsed);
    return { ok: true, data: (parsed ?? {}) as T };
  } catch {
    return { ok: false, reason: 'error', detail: 'Network error' };
  }
}

// Query-param form (?action=X) works regardless of whether the
// `/api/trades/<x>` rewrite is wired up in vercel.json — the dispatcher
// reads `req.query.action` directly. Used uniformly here so the UI
// surface doesn't couple to the rewrite configuration.
export function cancelProposal(id: string): Promise<ActionResult> {
  return post('/api/trades?action=cancel', { id });
}

export function acceptProposal(id: string): Promise<ActionResult<{ id: string; status: string }>> {
  return post('/api/trades?action=accept', { id });
}

export function declineProposal(id: string): Promise<ActionResult<{ id: string; status: string }>> {
  return post('/api/trades?action=decline', { id });
}

export function nudgeProposal(
  id: string,
  note?: string,
): Promise<ActionResult<{ id: string; nudgedAt: string }>> {
  return post('/api/trades?action=nudge', note ? { id, note } : { id });
}

export function promoteProposalToShared(
  id: string,
): Promise<ActionResult<{ sessionId: string; created: boolean }>> {
  return post('/api/trades?action=promote-to-shared', { proposalId: id });
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
  return post('/api/trades?action=bulk-resolve', { ids, action });
}
