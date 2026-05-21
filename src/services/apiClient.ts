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
 *     schema in the trailing options bag (or directly for back-compat
 *     with the legacy positional form) to validate server JSON before
 *     it's typed as `T`; without a schema the type cast is unchecked.
 *     Wire incrementally — hot paths first. Audit 08-types-deadcode #2.
 *   - **Domain-error mapping**: 400-class responses with a known
 *     `error` tag (per-endpoint enum) get the tag returned as the
 *     `reason` field, so callers narrow on a typed union instead of
 *     pattern-matching server strings. Pass `domainErrors` in the
 *     opts bag with the list of legal tags for that endpoint.
 *
 * The legacy positional `schema` argument is still accepted as the
 * 3rd parameter for back-compat with the one call site that used it
 * (`useAuth.ts`); new code should use the opts bag.
 */
import type { ZodType } from 'zod';

export type ActionFailureReason =
  | 'already-resolved'
  | 'rate-limited'
  | 'not-found'
  | 'forbidden'
  | 'unauthorized'
  | 'error';

export type ActionResult<T = Record<string, never>, E extends string = never> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: ActionFailureReason | E;
      detail?: string;
      /** For `rate-limited` — ISO timestamp when the next attempt is
       *  allowed. */
      nextAvailableAt?: string;
    };

/**
 * Options bag for the fetch helpers. Both `schema` and `domainErrors`
 * are opt-in; pass only what each endpoint needs.
 */
export interface ApiOptions<T = unknown, E extends string = never> {
  /** Zod schema that validates the success-body shape. */
  schema?: ZodType<T>;
  /** Set of domain-error tags this endpoint can return in a 400 body's
   *  `error` field. When the server returns one of these, the reason
   *  is narrowed to that tag (typed via `E`). Any other 400 body
   *  falls through to the generic `'error'` reason. */
  domainErrors?: readonly E[];
}

// Internal: accept either the legacy ZodType positional or an opts bag.
type ThirdArg<T, E extends string> = ZodType<T> | ApiOptions<T, E> | undefined;

function unwrapOpts<T, E extends string>(arg: ThirdArg<T, E>): ApiOptions<T, E> {
  if (!arg) return {};
  // ZodType instances expose `.safeParse`; opts bags don't. Use that
  // to tell them apart at runtime without losing the static types.
  if ('safeParse' in arg) return { schema: arg };
  return arg;
}

function failure<E extends string>(
  status: number,
  body: Record<string, unknown> | null,
  domainErrors: readonly E[] | undefined,
): Extract<ActionResult<never, E>, { ok: false }> {
  const detail = typeof body?.detail === 'string'
    ? body.detail
    : typeof body?.error === 'string' ? body.error : undefined;
  // Known domain-error tag → reason is the tag itself. The server
  // signals these via a dedicated `code` field so we don't have to
  // pattern-match human-readable error strings. This works across
  // status codes (a 400 'note-too-long' and a 409 'not-active' both
  // travel as `code` tags) so endpoints don't have to converge on a
  // single status to participate.
  if (domainErrors && domainErrors.length > 0) {
    const tag = typeof body?.code === 'string' ? body.code : undefined;
    if (tag && (domainErrors as readonly string[]).includes(tag)) {
      return { ok: false, reason: tag as E, detail };
    }
  }
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

async function request<T, E extends string>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body: unknown,
  opts: ApiOptions<T, E>,
): Promise<ActionResult<T, E>> {
  try {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    // Tolerate empty bodies — both success (204) and some error
    // responses ship no JSON.
    const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) return failure(res.status, parsed, opts.domainErrors);
    const raw = parsed ?? {};
    if (opts.schema) {
      const result = opts.schema.safeParse(raw);
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

export function apiGet<T, E extends string = never>(
  url: string,
  opts?: ThirdArg<T, E>,
): Promise<ActionResult<T, E>> {
  return request<T, E>('GET', url, undefined, unwrapOpts(opts));
}

export function apiPost<T, E extends string = never>(
  url: string,
  body?: unknown,
  opts?: ThirdArg<T, E>,
): Promise<ActionResult<T, E>> {
  return request<T, E>('POST', url, body ?? {}, unwrapOpts(opts));
}

export function apiPut<T, E extends string = never>(
  url: string,
  body?: unknown,
  opts?: ThirdArg<T, E>,
): Promise<ActionResult<T, E>> {
  return request<T, E>('PUT', url, body ?? {}, unwrapOpts(opts));
}

export function apiDelete<T, E extends string = never>(
  url: string,
  body?: unknown,
  opts?: ThirdArg<T, E>,
): Promise<ActionResult<T, E>> {
  return request<T, E>('DELETE', url, body, unwrapOpts(opts));
}

// Type-level assertion: ensure the exported ActionFailureReason from
// tradeActions includes 'unauthorized' now that we've added that case.
type _AssertUnauthorizedReason = Extract<ActionFailureReason, 'unauthorized'>;
const _assertUnauthorized: _AssertUnauthorizedReason = 'unauthorized';
void _assertUnauthorized;
