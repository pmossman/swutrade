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
