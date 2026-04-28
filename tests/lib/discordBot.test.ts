import { describe, it, expect } from 'vitest';
import { createDiscordBotClient } from '../../lib/discordBot.js';
import {
  DiscordRateLimitError,
  DiscordValidationError,
  DiscordServerError,
} from '../../lib/discordErrors.js';

/**
 * Retry + error-typing behaviour inside `createDiscordBotClient`'s
 * `request` helper, driven by an injected fetch so we control the
 * response sequence deterministically.
 */

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('createDiscordBotClient.request — retry + error typing', () => {
  it('retries once on 429 with the Retry-After sleep, then returns the successful response', async () => {
    const responses = [
      errorResponse(429, { retry_after: 1, global: false }, { 'retry-after': '1' }),
      okResponse({ id: 'msg-1', channel_id: 'dm-1' }),
    ];
    const sleepCalls: number[] = [];
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => responses.shift()!) as typeof fetch,
      sleep: async ms => { sleepCalls.push(ms); },
    });

    const sent = await client.postChannelMessage('123456789012345678', { content: 'hi' });
    expect(sent.id).toBe('msg-1');
    // One retry, and we slept for the header-supplied 1 second (1000ms).
    expect(sleepCalls).toEqual([1000]);
    expect(responses).toHaveLength(0);
  });

  it('caps retry sleep at maxRetrySleepSeconds so a malicious Retry-After can\'t hang a function', async () => {
    const responses = [
      errorResponse(429, { retry_after: 3600 }, { 'retry-after': '3600' }),
      okResponse({ id: 'msg-2', channel_id: 'dm-2' }),
    ];
    const sleepCalls: number[] = [];
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => responses.shift()!) as typeof fetch,
      sleep: async ms => { sleepCalls.push(ms); },
      maxRetrySleepSeconds: 5,
    });

    await client.postChannelMessage('123456789012345678', { content: 'hi' });
    expect(sleepCalls).toEqual([5000]);
  });

  it('throws DiscordRateLimitError when 429 repeats past the retry budget', async () => {
    const responses = [
      errorResponse(429, { retry_after: 0.1 }, { 'retry-after': '0' }),
      errorResponse(429, { retry_after: 0.1 }, { 'retry-after': '0' }),
    ];
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => responses.shift()!) as typeof fetch,
      sleep: async () => {},
      maxRetries: 1,
    });

    await expect(client.postChannelMessage('123456789012345678', { content: 'hi' })).rejects.toMatchObject({
      name: 'DiscordRateLimitError',
      status: 429,
    });
  });

  it('does NOT retry on 400 — validation errors are our bug, not Discord\'s, and another attempt wouldn\'t change anything', async () => {
    let calls = 0;
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => {
        calls += 1;
        return errorResponse(400, {
          code: 50035,
          message: 'Invalid Form Body',
        });
      }) as typeof fetch,
      sleep: async () => {},
    });

    await expect(client.postChannelMessage('123456789012345678', { content: 'hi' }))
      .rejects.toBeInstanceOf(DiscordValidationError);
    expect(calls).toBe(1);
  });

  it('does NOT retry on 5xx for non-idempotent writes — POST /messages dupes if the upstream already created the message', async () => {
    let calls = 0;
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => {
        calls += 1;
        return errorResponse(502, {});
      }) as typeof fetch,
      sleep: async () => {},
    });

    // Real Discord-snowflake-formatted recipient so the synthetic-id
    // short-circuit doesn't intercept; we want the 5xx path.
    await expect(client.postChannelMessage('123456789012345678', { content: 'hi' }))
      .rejects.toBeInstanceOf(DiscordServerError);
    expect(calls).toBe(1);
  });

  it('DOES retry once on 5xx for idempotent endpoints — createDmChannel returns the existing DM, safe to re-attempt', async () => {
    const responses = [
      errorResponse(503, {}),
      okResponse({ id: '987654321098765432' }),
    ];
    const sleepCalls: number[] = [];
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => responses.shift()!) as typeof fetch,
      sleep: async ms => { sleepCalls.push(ms); },
    });

    const dm = await client.createDmChannel('123456789012345678');
    expect(dm.id).toBe('987654321098765432');
    expect(sleepCalls).toEqual([500]);
    expect(responses).toHaveLength(0);
  });

  it('5xx retry on idempotent endpoint surfaces DiscordServerError after maxRetries exhausted', async () => {
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => errorResponse(503, {})) as typeof fetch,
      sleep: async () => {},
      maxRetries: 1,
    });
    await expect(client.createDmChannel('123456789012345678'))
      .rejects.toBeInstanceOf(DiscordServerError);
  });

  it('short-circuits synthetic discord ids without hitting the network — fixture data minted by tests never reaches Discord', async () => {
    let calls = 0;
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => {
        calls += 1;
        return okResponse({});
      }) as typeof fetch,
      sleep: async () => {},
    });

    // sendDirectMessage with a synthetic recipient: no createDm,
    // no postMessage — both legs are short-circuited.
    const sent = await client.sendDirectMessage('test-iso-1-abc12345', { content: 'hi' });
    expect(sent.channel_id).toBe('synth-dm-test-iso-1-abc12345');
    expect(sent.id).toMatch(/^synth-msg-/);

    // editChannelMessage with a synthetic channelId is a no-op.
    await client.editChannelMessage('synth-dm-test-iso-1-abc12345', 'synth-msg-xyz', { content: 'edited' });

    // addThreadMember is a no-op on synthetic ids on either side.
    await client.addThreadMember('synth-thread-x', 'test-iso-2-def');

    // deleteChannel is a no-op on synthetic ids.
    await client.deleteChannel('synth-dm-test-iso-1-abc12345');

    expect(calls).toBe(0);
  });

  it('maxRetries=0 disables the 429 auto-retry entirely', async () => {
    let calls = 0;
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => {
        calls += 1;
        return errorResponse(429, { retry_after: 1 }, { 'retry-after': '1' });
      }) as typeof fetch,
      sleep: async () => {},
      maxRetries: 0,
    });

    await expect(client.postChannelMessage('123456789012345678', { content: 'hi' }))
      .rejects.toBeInstanceOf(DiscordRateLimitError);
    expect(calls).toBe(1);
  });

  it('successful first-try calls never sleep + never construct an error', async () => {
    let sleepCalled = false;
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => okResponse({ id: 'msg-ok', channel_id: 'dm-ok' })) as typeof fetch,
      sleep: async () => { sleepCalled = true; },
    });
    const r = await client.postChannelMessage('123456789012345678', { content: 'hi' });
    expect(r.id).toBe('msg-ok');
    expect(sleepCalled).toBe(false);
  });
});
