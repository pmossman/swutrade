/*
 * Thin fetch wrapper that maps HTTP status to a reason discriminator,
 * matching the v1 shape from src/services/apiClient.ts.
 */

export type ActionReason =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'already-resolved'
  | 'rate-limited'
  | 'error';

export class ApiError extends Error {
  readonly reason: ActionReason;
  readonly status: number;
  readonly detail?: unknown;

  constructor(message: string, reason: ActionReason, status: number, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

function reasonFromStatus(status: number): ActionReason {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'already-resolved';
  if (status === 429) return 'rate-limited';
  return 'error';
}

export async function apiGet<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    method: 'GET',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const body = await safeParseBody(res);
    throw new ApiError(
      `GET ${url} → ${res.status}`,
      reasonFromStatus(res.status),
      res.status,
      body,
    );
  }
  return (await res.json()) as T;
}

export async function apiPost<T>(url: string, body?: unknown, init?: RequestInit): Promise<T> {
  return sendJson<T>('POST', url, body, init);
}

export async function apiPut<T>(url: string, body?: unknown, init?: RequestInit): Promise<T> {
  return sendJson<T>('PUT', url, body, init);
}

export async function apiDelete<T>(url: string, init?: RequestInit): Promise<T> {
  return sendJson<T>('DELETE', url, undefined, init);
}

async function sendJson<T>(
  method: string,
  url: string,
  body: unknown,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = await safeParseBody(res);
    throw new ApiError(
      `${method} ${url} → ${res.status}`,
      reasonFromStatus(res.status),
      res.status,
      parsed,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function safeParseBody(res: Response): Promise<unknown> {
  try {
    return await res.clone().json();
  } catch {
    try {
      return await res.text();
    } catch {
      return null;
    }
  }
}
