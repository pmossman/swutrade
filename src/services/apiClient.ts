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
 *   - Optional zod-schema validation of the response body. Pass a
 *     schema as the trailing argument to validate server JSON before
 *     it's typed as `T`; without a schema the type cast is unchecked
 *     (current per-call-site behaviour). Wire incrementally — hot
 *     paths first. Audit 08-types-deadcode #2.
 *
 * The `ActionResult` type lives in `./tradeActions` (it originated
 * there); both files share the type surface. `tradeActions.ts`'s
 * stateless POST helpers (cancelProposal, accept, etc.) call `apiPost`
 * for the actual HTTP work — there's no duplicate status-mapping.
 */
import type { ZodType } from 'zod';
import type { ActionResult, ActionFailureReason } from './tradeActions';
export type { ActionResult, ActionFailureReason } from './tradeActions';

function failure(
  status: number,
  body: Record<string, unknown> | null,
): Extract<ActionResult, { ok: false }> {
  // Most endpoints return `{ error: "..." }`; a few legacy ones return
  // `{ detail: "..." }`. Read either so the UI can show the server-
  // provided message regardless of which convention the endpoint follows.
  const detail = typeof body?.detail === 'string'
    ? body.detail
    : typeof body?.error === 'string' ? body.error : undefined;
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
  schema?: ZodType<T>,
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
    const raw = parsed ?? {};
    if (schema) {
      // Validate before the cast lands; surface a typed error if the
      // server's wire shape drifted. The 'error' bucket is the same
      // one network failures land in, so callers don't need a new
      // branch.
      const result = schema.safeParse(raw);
      if (!result.success) {
        return {
          ok: false,
          reason: 'error',
          detail: `Response shape invalid: ${result.error.message}`,
        };
      }
      return { ok: true, data: result.data };
    }
    return { ok: true, data: raw as T };
  } catch {
    return { ok: false, reason: 'error', detail: 'Network error' };
  }
}

export function apiGet<T>(url: string, schema?: ZodType<T>): Promise<ActionResult<T>> {
  return request<T>('GET', url, undefined, schema);
}

export function apiPost<T>(
  url: string,
  body?: unknown,
  schema?: ZodType<T>,
): Promise<ActionResult<T>> {
  return request<T>('POST', url, body ?? {}, schema);
}

export function apiPut<T>(
  url: string,
  body?: unknown,
  schema?: ZodType<T>,
): Promise<ActionResult<T>> {
  return request<T>('PUT', url, body ?? {}, schema);
}

export function apiDelete<T>(
  url: string,
  body?: unknown,
  schema?: ZodType<T>,
): Promise<ActionResult<T>> {
  return request<T>('DELETE', url, body, schema);
}

// Type-level assertion: ensure the exported ActionFailureReason from
// tradeActions includes 'unauthorized' now that we've added that case.
// This produces a compile error if tradeActions.ts drifts out of sync.
type _AssertUnauthorizedReason = Extract<ActionFailureReason, 'unauthorized'>;
const _assertUnauthorized: _AssertUnauthorizedReason = 'unauthorized';
void _assertUnauthorized;
