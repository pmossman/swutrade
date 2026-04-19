import { describe, it, expect } from 'vitest';
import {
  classifyDiscordError,
  DiscordRateLimitError,
  DiscordPermissionError,
  DiscordNotFoundError,
  DiscordValidationError,
  DiscordServerError,
  DiscordUnknownError,
  DiscordApiError,
} from '../../lib/discordErrors.js';

/**
 * `classifyDiscordError` is the seam between Discord's HTTP wire
 * format and the rest of the codebase's typed error handling —
 * covering the mapping table tightly here keeps every consumer
 * downstream honest without needing live Discord fixtures.
 */

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

describe('classifyDiscordError', () => {
  it('429 with Retry-After header → DiscordRateLimitError carrying header value', () => {
    const err = classifyDiscordError(
      429,
      'POST',
      '/channels/1/messages',
      '{"message":"You are being rate limited.","retry_after":0.5,"global":false,"code":0}',
      headers({ 'retry-after': '2' }),
    );
    expect(err).toBeInstanceOf(DiscordRateLimitError);
    const rl = err as DiscordRateLimitError;
    // Header wins over the JSON body's retry_after field.
    expect(rl.retryAfterSeconds).toBe(2);
    expect(rl.global).toBe(false);
    expect(rl.status).toBe(429);
  });

  it('429 with no header falls back to body retry_after', () => {
    const err = classifyDiscordError(
      429,
      'POST',
      '/channels/1/messages',
      '{"message":"throttled","retry_after":4,"global":true}',
      headers(),
    );
    const rl = err as DiscordRateLimitError;
    expect(rl.retryAfterSeconds).toBe(4);
    expect(rl.global).toBe(true);
  });

  it('429 with neither header nor body falls back to 1s', () => {
    const err = classifyDiscordError(429, 'POST', '/x', '', headers()) as DiscordRateLimitError;
    expect(err.retryAfterSeconds).toBe(1);
  });

  it('403 → DiscordPermissionError; Discord code surfaces on the error', () => {
    const err = classifyDiscordError(
      403,
      'POST',
      '/users/@me/channels',
      '{"message":"Cannot send messages to this user","code":50007}',
      headers(),
    );
    expect(err).toBeInstanceOf(DiscordPermissionError);
    expect(err.discordCode).toBe(50007);
  });

  it('404 → DiscordNotFoundError', () => {
    const err = classifyDiscordError(404, 'GET', '/channels/999', '{"message":"Unknown Channel","code":10003}', headers());
    expect(err).toBeInstanceOf(DiscordNotFoundError);
  });

  it('400 → DiscordValidationError (this is the class the embed-truncation bug raised)', () => {
    const err = classifyDiscordError(
      400,
      'POST',
      '/channels/1/messages',
      '{"message":"Invalid Form Body","code":50035,"errors":{"embeds":{"0":{"fields":{"0":{"value":{"_errors":[{"code":"BASE_TYPE_MAX_LENGTH"}]}}}}}}}',
      headers(),
    );
    expect(err).toBeInstanceOf(DiscordValidationError);
    expect(err.discordCode).toBe(50035);
  });

  // Code 40003 ("opening DMs too fast") comes back as HTTP 400 but is
  // semantically a rate limit — we re-classify it so silent-fail noise
  // from fast bulk declines doesn't leak to #bot-errors.
  it('400 + code 40003 → DiscordRateLimitError (DM-open rate limit)', () => {
    const err = classifyDiscordError(
      400,
      'POST',
      '/users/@me/channels',
      '{"message":"You are opening direct messages too fast.","code":40003}',
      headers(),
    );
    expect(err).toBeInstanceOf(DiscordRateLimitError);
    expect((err as DiscordRateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    expect((err as DiscordRateLimitError).global).toBe(false);
  });

  it('500 + 502 + 503 → DiscordServerError', () => {
    for (const status of [500, 502, 503]) {
      const err = classifyDiscordError(status, 'GET', '/gateway', '', headers());
      expect(err, `status ${status}`).toBeInstanceOf(DiscordServerError);
    }
  });

  it('anything else (418, etc.) → DiscordUnknownError', () => {
    const err = classifyDiscordError(418, 'GET', '/teapot', '', headers());
    expect(err).toBeInstanceOf(DiscordUnknownError);
  });

  it('preserves the detail fields every caller might want to log', () => {
    const err = classifyDiscordError(
      400,
      'PATCH',
      '/channels/abc/messages/def',
      '{"code":50035,"message":"bad payload","errors":{...}}',
      headers(),
    );
    expect(err.method).toBe('PATCH');
    expect(err.path).toBe('/channels/abc/messages/def');
    expect(err.status).toBe(400);
    expect(err.bodySnippet).toContain('50035');
  });

  it('every subclass is an instance of the base DiscordApiError', () => {
    const cases = [
      classifyDiscordError(429, 'GET', '/', '', headers()),
      classifyDiscordError(403, 'GET', '/', '', headers()),
      classifyDiscordError(404, 'GET', '/', '', headers()),
      classifyDiscordError(400, 'GET', '/', '', headers()),
      classifyDiscordError(502, 'GET', '/', '', headers()),
      classifyDiscordError(418, 'GET', '/', '', headers()),
    ];
    for (const c of cases) {
      expect(c).toBeInstanceOf(DiscordApiError);
    }
  });
});
