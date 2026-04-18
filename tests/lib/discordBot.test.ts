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

    const sent = await client.postChannelMessage('channel-1', { content: 'hi' });
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

    await client.postChannelMessage('channel-1', { content: 'hi' });
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

    await expect(client.postChannelMessage('channel-1', { content: 'hi' })).rejects.toMatchObject({
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

    await expect(client.postChannelMessage('channel-1', { content: 'hi' }))
      .rejects.toBeInstanceOf(DiscordValidationError);
    expect(calls).toBe(1);
  });

  it('does NOT retry on 5xx — most bot writes aren\'t idempotent, a blind retry risks dupes', async () => {
    let calls = 0;
    const client = createDiscordBotClient({
      token: 'test-token',
      fetch: (async () => {
        calls += 1;
        return errorResponse(502, {});
      }) as typeof fetch,
      sleep: async () => {},
    });

    await expect(client.postChannelMessage('channel-1', { content: 'hi' }))
      .rejects.toBeInstanceOf(DiscordServerError);
    expect(calls).toBe(1);
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

    await expect(client.postChannelMessage('channel-1', { content: 'hi' }))
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
    const r = await client.postChannelMessage('channel-1', { content: 'hi' });
    expect(r.id).toBe('msg-ok');
    expect(sleepCalled).toBe(false);
  });
});
