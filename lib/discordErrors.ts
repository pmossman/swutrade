/**
 * Typed error hierarchy for Discord REST API failures.
 *
 * Before this module every failure from `DiscordBotClient` threw an
 * opaque `Error`, so callers couldn't tell "rate-limited, retry in a
 * bit" from "the payload's garbage, fix the code" from "bot lost its
 * token." That conflation turned real incidents into silent
 * `delivery_status=failed` rows with no actionable signal.
 *
 * Each subclass carries the HTTP status + any useful Discord fields
 * so the call site can react meaningfully:
 *   - `RateLimit` → retry after `retryAfterSeconds`
 *   - `Permission` → bot is missing a scope; tell the installer
 *   - `NotFound` → resource gone (user deleted, channel removed)
 *   - `Validation` → our bug; the payload didn't match Discord's schema
 *   - `Server` → Discord's fault; callers may retry or degrade
 *   - `Unknown` → catch-all (e.g., network errors before a response)
 */

export interface DiscordErrorDetail {
  status: number;
  method: string;
  path: string;
  discordCode?: number;
  bodySnippet?: string;
}

export abstract class DiscordApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly discordCode?: number;
  readonly bodySnippet?: string;

  constructor(message: string, detail: DiscordErrorDetail) {
    super(message);
    this.name = this.constructor.name;
    this.status = detail.status;
    this.method = detail.method;
    this.path = detail.path;
    this.discordCode = detail.discordCode;
    this.bodySnippet = detail.bodySnippet;
  }
}

/**
 * HTTP 429 — Discord is throttling us. `retryAfterSeconds` comes from
 * the Retry-After header (preferred) or the JSON body's
 * `retry_after` field (fallback; Discord sends both for backward
 * compat). Callers can schedule a delayed retry; the client already
 * performs one automatic retry on 429 before throwing.
 */
export class DiscordRateLimitError extends DiscordApiError {
  readonly retryAfterSeconds: number;
  /** Whether Discord flagged this as a global rate limit — those
   *  apply bot-wide, not per-endpoint, and callers may want to
   *  pause everything briefly. */
  readonly global: boolean;
  constructor(message: string, detail: DiscordErrorDetail & { retryAfterSeconds: number; global: boolean }) {
    super(message, detail);
    this.retryAfterSeconds = detail.retryAfterSeconds;
    this.global = detail.global;
  }
}

/** HTTP 403 — bot is missing a permission or the user has DMs off.
 *  Discord's error code 50007 = "Cannot send messages to this user"
 *  (DMs disabled), separate from channel-level permission failures. */
export class DiscordPermissionError extends DiscordApiError {}

/** HTTP 404 — the resource (user, channel, message) doesn't exist or
 *  is no longer accessible to the bot. Not retryable. */
export class DiscordNotFoundError extends DiscordApiError {}

/** HTTP 400 — the payload didn't pass Discord's schema validation.
 *  Almost always OUR bug (field-length limit, invalid enum, etc.),
 *  not something the caller can fix at runtime. */
export class DiscordValidationError extends DiscordApiError {}

/** HTTP 5xx — Discord's fault. Callers may retry, degrade, or
 *  surface to the user with "Discord's having issues right now." */
export class DiscordServerError extends DiscordApiError {}

/** Catch-all — non-HTTP failures (network errors, malformed JSON
 *  from Discord, unexpected status codes). */
export class DiscordUnknownError extends DiscordApiError {}

/**
 * Build a typed error from a failed fetch Response. Caller passes
 * the already-read body text so we don't race with Response stream
 * consumption.
 */
export function classifyDiscordError(
  status: number,
  method: string,
  path: string,
  bodyText: string,
  headers: Headers,
): DiscordApiError {
  const snippet = bodyText.slice(0, 400);
  let discordCode: number | undefined;
  let discordMessage: string | undefined;
  let retryAfterFromBody: number | undefined;
  let global = false;
  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed?.code === 'number') discordCode = parsed.code;
    if (typeof parsed?.message === 'string') discordMessage = parsed.message;
    if (typeof parsed?.retry_after === 'number') retryAfterFromBody = parsed.retry_after;
    if (typeof parsed?.global === 'boolean') global = parsed.global;
  } catch {
    // Non-JSON body (rare); leave fields undefined.
  }

  const baseDetail: DiscordErrorDetail = {
    status,
    method,
    path,
    discordCode,
    bodySnippet: snippet,
  };
  const label = discordMessage ? ` — ${discordMessage}` : '';
  const message = `Discord ${method} ${path} → ${status}${discordCode ? ` [${discordCode}]` : ''}${label}`;

  if (status === 429) {
    const retryHeader = Number(headers.get('retry-after'));
    const retryAfterSeconds = Number.isFinite(retryHeader) && retryHeader > 0
      ? retryHeader
      : (retryAfterFromBody ?? 1);
    return new DiscordRateLimitError(message, { ...baseDetail, retryAfterSeconds, global });
  }
  if (status === 403) return new DiscordPermissionError(message, baseDetail);
  if (status === 404) return new DiscordNotFoundError(message, baseDetail);
  if (status === 400) return new DiscordValidationError(message, baseDetail);
  if (status >= 500) return new DiscordServerError(message, baseDetail);
  return new DiscordUnknownError(message, baseDetail);
}
