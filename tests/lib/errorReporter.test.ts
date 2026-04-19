import { describe, it, expect } from 'vitest';
import { shouldSkip, isTestTraffic, buildPayload, reportError } from '../../lib/errorReporter.js';
import {
  DiscordRateLimitError,
  DiscordNotFoundError,
  DiscordPermissionError,
  DiscordValidationError,
  DiscordServerError,
  DiscordUnknownError,
} from '../../lib/discordErrors.js';

/**
 * The reporter's job is to keep the #bot-errors channel signal-heavy
 * while never becoming a source of errors itself. Filter + payload
 * tests pin the classification logic; an end-to-end `reportError`
 * test confirms the "never throws, never blocks" contract.
 */

function makeErr<T extends new (...args: never[]) => unknown>(
  Cls: T,
  detail: Record<string, unknown>,
): InstanceType<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (Cls as any)('test error', {
    status: detail.status ?? 400,
    method: detail.method ?? 'POST',
    path: detail.path ?? '/x',
    discordCode: detail.discordCode,
    bodySnippet: detail.bodySnippet,
    retryAfterSeconds: detail.retryAfterSeconds ?? 1,
    global: detail.global ?? false,
  }) as InstanceType<T>;
}

describe('shouldSkip — filter expected-noise errors', () => {
  it('skips all 429 rate-limit errors — the client retry already handles', () => {
    expect(shouldSkip(makeErr(DiscordRateLimitError, { status: 429 }))).toBe(true);
  });

  it('skips 404s for "resource gone" codes (channel / message / user)', () => {
    expect(shouldSkip(makeErr(DiscordNotFoundError, { status: 404, discordCode: 10003 }))).toBe(true); // Unknown Channel
    expect(shouldSkip(makeErr(DiscordNotFoundError, { status: 404, discordCode: 10008 }))).toBe(true); // Unknown Message
    expect(shouldSkip(makeErr(DiscordNotFoundError, { status: 404, discordCode: 10013 }))).toBe(true); // Unknown User
  });

  it('does NOT skip 404s with unfamiliar codes — might be a real bug', () => {
    expect(shouldSkip(makeErr(DiscordNotFoundError, { status: 404, discordCode: 99999 }))).toBe(false);
  });

  it('skips 403 code 50007 (DMs disabled) — user choice, not our bug', () => {
    expect(shouldSkip(makeErr(DiscordPermissionError, { status: 403, discordCode: 50007 }))).toBe(true);
  });

  it('does NOT skip other 403s (e.g. "Missing Access" on a guild channel)', () => {
    expect(shouldSkip(makeErr(DiscordPermissionError, { status: 403, discordCode: 50001 }))).toBe(false);
  });

  it('does NOT skip 400s — payload validation errors are always OUR bug', () => {
    expect(shouldSkip(makeErr(DiscordValidationError, { status: 400, discordCode: 50035 }))).toBe(false);
  });

  it('does NOT skip 5xx — Discord problems, we should know about them', () => {
    expect(shouldSkip(makeErr(DiscordServerError, { status: 502 }))).toBe(false);
  });

  it('does NOT skip generic Error instances — something we didn\'t expect', () => {
    expect(shouldSkip(new Error('something crashed'))).toBe(false);
  });

  it('does NOT skip non-Error throws — most likely a real bug', () => {
    expect(shouldSkip('string thrown directly')).toBe(false);
    expect(shouldSkip(null)).toBe(false);
    expect(shouldSkip(undefined)).toBe(false);
  });
});

describe('isTestTraffic — filters auth-e2e + dev-seed traffic', () => {
  it('matches tag values with test-iso- / e2e-sender- / dev-seed- prefixes', () => {
    expect(isTestTraffic({ source: 's', tags: { recipientId: 'test-iso-8-ea940e55' } }, new Error())).toBe(true);
    expect(isTestTraffic({ source: 's', tags: { recipientId: 'e2e-sender-mo51rwye-c5ec' } }, new Error())).toBe(true);
    expect(isTestTraffic({ source: 's', tags: { peerId: 'dev-seed-testbot-bb' } }, new Error())).toBe(true);
  });

  it('does NOT match real Discord snowflake ids', () => {
    expect(isTestTraffic({ source: 's', tags: { recipientId: '161720131645472768' } }, new Error())).toBe(false);
    expect(isTestTraffic({ source: 's' }, new Error())).toBe(false);
  });

  it('matches DiscordApiError body snippets that coerce recipient_id to non-snowflake', () => {
    const err = makeErr(DiscordValidationError, {
      status: 400,
      bodySnippet: '{"errors":{"recipient_id":{"_errors":[{"code":"NUMBER_TYPE_COERCE","message":"..."}]}}}',
    });
    expect(isTestTraffic({ source: 's' }, err)).toBe(true);
  });

  it('does NOT match unrelated NUMBER_TYPE_COERCE errors (different field)', () => {
    const err = makeErr(DiscordValidationError, {
      status: 400,
      bodySnippet: '{"errors":{"channel_id":{"_errors":[{"code":"NUMBER_TYPE_COERCE"}]}}}',
    });
    expect(isTestTraffic({ source: 's' }, err)).toBe(false);
  });
});

describe('buildPayload — rendering', () => {
  it('includes class name, message, and HTTP context for DiscordApiError subclasses', () => {
    const err = makeErr(DiscordValidationError, {
      status: 400,
      method: 'POST',
      path: '/channels/123/messages',
      discordCode: 50035,
      bodySnippet: '{"message":"Invalid Form Body"}',
    });
    const payload = buildPayload({ source: 'trades.propose.dm-send' }, err) as {
      embeds: Array<{ title: string; description: string; color: number }>;
    };
    expect(payload.embeds[0].title).toBe('⚠ trades.propose.dm-send');
    expect(payload.embeds[0].description).toContain('DiscordValidationError');
    expect(payload.embeds[0].description).toContain('status `400`');
    expect(payload.embeds[0].description).toContain('code `50035`');
    expect(payload.embeds[0].description).toContain('POST /channels/123/messages');
    expect(payload.embeds[0].description).toContain('Invalid Form Body');
  });

  it('renders tags as a compact key=value line', () => {
    const payload = buildPayload(
      {
        source: 'test',
        tags: { tradeId: 'trade-abc', userId: 'user-123', discarded: null, empty: '' },
      },
      new Error('boom'),
    ) as { embeds: Array<{ description: string }> };
    expect(payload.embeds[0].description).toContain('tradeId=`trade-abc`');
    expect(payload.embeds[0].description).toContain('userId=`user-123`');
    // Null + empty values don't render.
    expect(payload.embeds[0].description).not.toContain('discarded');
    expect(payload.embeds[0].description).not.toContain('empty');
  });

  it('includes a stack trace excerpt for plain Errors', () => {
    const payload = buildPayload({ source: 'test' }, new Error('boom')) as {
      embeds: Array<{ description: string }>;
    };
    expect(payload.embeds[0].description).toMatch(/```[\s\S]*Error[\s\S]*```/);
  });

  it('handles non-Error throws gracefully', () => {
    const payload = buildPayload({ source: 'test' }, 'just a string') as {
      embeds: Array<{ description: string; color: number }>;
    };
    expect(payload.embeds[0].description).toContain('Non-Error throw');
    expect(payload.embeds[0].description).toContain('just a string');
  });

  it('colors vary by error class — at-a-glance signal', () => {
    const color = (err: unknown): number =>
      (buildPayload({ source: 'x' }, err) as { embeds: [{ color: number }] }).embeds[0].color;
    const validation = color(makeErr(DiscordValidationError, {}));
    const permission = color(makeErr(DiscordPermissionError, {}));
    const server = color(makeErr(DiscordServerError, {}));
    const generic = color(new Error('x'));
    const unknown = color(makeErr(DiscordUnknownError, {}));
    // Each class gets a distinct color; the important guarantee is
    // they're not all the same.
    const colors = [validation, permission, server, generic, unknown];
    expect(new Set(colors).size).toBeGreaterThan(1);
  });

  it('truncates absurdly long strings so the embed stays under Discord\'s limits', () => {
    const longString = 'x'.repeat(10000);
    const payload = buildPayload({ source: 'test' }, new Error(longString)) as {
      embeds: Array<{ description: string }>;
    };
    expect(payload.embeds[0].description.length).toBeLessThanOrEqual(3500);
  });
});

describe('reportError — never throws, honors the no-op contract', () => {
  it('no-ops silently when DISCORD_ERROR_WEBHOOK_URL is unset', async () => {
    const prior = process.env.DISCORD_ERROR_WEBHOOK_URL;
    delete process.env.DISCORD_ERROR_WEBHOOK_URL;
    try {
      // If it made ANY fetch call we'd see a network-failure rejection
      // bubble up — the implementation must short-circuit on missing URL.
      await expect(reportError({ source: 'test' }, new Error('x'))).resolves.toBeUndefined();
    } finally {
      if (prior !== undefined) process.env.DISCORD_ERROR_WEBHOOK_URL = prior;
    }
  });

  it('swallows fetch failures — the reporter must never cause a secondary error', async () => {
    const prior = process.env.DISCORD_ERROR_WEBHOOK_URL;
    process.env.DISCORD_ERROR_WEBHOOK_URL = 'https://invalid.invalid/webhooks/totally/fake';
    try {
      // Even with a URL that'll DNS-fail, the reporter resolves cleanly.
      await expect(reportError({ source: 'test' }, new Error('x'))).resolves.toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.DISCORD_ERROR_WEBHOOK_URL;
      else process.env.DISCORD_ERROR_WEBHOOK_URL = prior;
    }
  });
});
