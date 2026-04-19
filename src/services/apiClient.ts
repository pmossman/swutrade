/**
 * Shared API client. Every client-side hook that hits `/api/*` should
 * route through here so error handling stays consistent. Wraps
 * `fetch()` with:
 *   - JSON request/response serialization (Content-Type + body handling)
 *   - A discriminated `ActionResult<T>` return shape: callers branch on
 *     `ok` and, when false, on `reason` — no parsing error strings.
 *   - Status-to-reason mapping so the UI can distinguish "you lost the
 *     race" (409), "cool it" (429 with nextAvailableAt), "gone" (404),
 *     "not yours" (403), "sign in again" (401) from generic errors.
 *
 * The result type is re-exported from `tradeActions.ts`, which
 * originated this pattern. `tradeActions.ts` continues to export its
 * stateless POST helpers unchanged (cancelProposal, accept, etc.).
 * It now piggy-backs on `apiPost` internally to avoid two copies of
 * the same status-mapping logic.
 */
import type { ActionResult, ActionFailureReason } from './tradeActions';
export type { ActionResult, ActionFailureReason } from './tradeActions';

function failure(
  status: number,
  body: Record<string, unknown> | null,
): Extract<ActionResult, { ok: false }> {
  const detail = typeof body?.detail === 'string' ? body.detail : undefined;
  if (status === 409) return { ok: false, reason: 'already-resolved', detail };
  if (status === 429) {
    const nextAvailableAt =
      typeof body?.nextAvailableAt === 'string' ? body.nextAvailableAt : undefined;
    return { ok: false, reason: 'rate-limited', detail, nextAvailableAt };
  }
  if (status === 404) return { ok: false, reason: 'not-found', detail };
  if (status === 403) return { ok: false, reason: 'forbidden', detail };
  if (status === 401) return { ok: false, reason: 'unauthorized', detail };
  return { ok: false, reason: 'error', detail };
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<ActionResult<T>> {
  try {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    // Tolerate empty bodies — both success (204) and some error
    // responses ship no JSON. `.catch(() => null)` keeps the happy
    // path clean without tripping on parse failures.
    const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) return failure(res.status, parsed);
    return { ok: true, data: (parsed ?? ({} as unknown)) as T };
  } catch {
    return { ok: false, reason: 'error', detail: 'Network error' };
  }
}

export function apiGet<T>(url: string): Promise<ActionResult<T>> {
  return request<T>('GET', url);
}

export function apiPost<T>(url: string, body?: unknown): Promise<ActionResult<T>> {
  return request<T>('POST', url, body ?? {});
}

export function apiPut<T>(url: string, body?: unknown): Promise<ActionResult<T>> {
  return request<T>('PUT', url, body ?? {});
}

export function apiDelete<T>(url: string, body?: unknown): Promise<ActionResult<T>> {
  return request<T>('DELETE', url, body);
}

// Re-export the failure helper for tradeActions.ts so it can piggy-back
// on the shared status mapping without duplicating the switch. Not part
// of the public API surface — consumers should use the verb helpers.
export { failure as __mapFailureForTradeActions };

// Type-level assertion: ensure the exported ActionFailureReason from
// tradeActions includes 'unauthorized' now that we've added that case.
// This produces a compile error if tradeActions.ts drifts out of sync.
type _AssertUnauthorizedReason = Extract<ActionFailureReason, 'unauthorized'>;
const _assertUnauthorized: _AssertUnauthorizedReason = 'unauthorized';
void _assertUnauthorized;
