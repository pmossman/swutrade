import { describeWithDb } from './helpers.js';
import { it, expect, afterEach, vi } from 'vitest';
import { handleFeedback } from '../../api/me.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  sealTestCookie,
} from './helpers.js';

/**
 * Coverage for /api/me/feedback. Validates the API contract:
 *   - POST-only.
 *   - Zod-validates body shape (kind / message / context).
 *   - Auth-optional — accepts anonymous reports as well as
 *     signed-in ones.
 *   - Returns 204 even when the Discord webhook isn't configured.
 *   - Webhook payload (when set) carries reporter handle + structured
 *     context.
 *
 * We don't go end-to-end into Discord — the lib helper has its own
 * unit tests covering payload shape + the never-throws contract.
 */
describeWithDb('POST /api/me/feedback', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];

  afterEach(async () => {
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
    delete process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  });

  it('rejects non-POST methods with 405', async () => {
    const res = mockResponse();
    await handleFeedback(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._headers.allow).toBe('POST');
  });

  it('rejects malformed body with 400', async () => {
    const res = mockResponse();
    await handleFeedback(
      mockRequest({ method: 'POST', body: { /* missing kind + message */ } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid body' });
  });

  it('rejects unknown kind values', async () => {
    const res = mockResponse();
    await handleFeedback(
      mockRequest({ method: 'POST', body: { kind: 'spam', message: 'hi' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('rejects empty / whitespace-only messages', async () => {
    const res = mockResponse();
    await handleFeedback(
      mockRequest({ method: 'POST', body: { kind: 'general', message: '   ' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('rejects messages longer than 1000 characters', async () => {
    const res = mockResponse();
    await handleFeedback(
      mockRequest({
        method: 'POST',
        body: { kind: 'general', message: 'x'.repeat(1001) },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('accepts an anonymous report (no session cookie) with 204', async () => {
    const res = mockResponse();
    await handleFeedback(
      mockRequest({
        method: 'POST',
        body: { kind: 'general', message: 'site loads slow on mobile' },
      }),
      res,
    );
    expect(res._status).toBe(204);
  });

  it('accepts a signed-in report and posts to Discord with the reporter handle', async () => {
    // Create the test user (and seal the session cookie) BEFORE
    // touching global.fetch — Neon's HTTP driver uses fetch under
    // the hood to talk to Postgres, so a blanket fetch mock would
    // break the DB call.
    const viewer = await createTestUser();
    fixtures.push(viewer);
    const cookie = await sealTestCookie(viewer.id);

    process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord/test-webhook';
    const originalFetch = global.fetch;
    // Selective mock: only intercept the Discord webhook URL, pass
    // anything else (e.g. Neon DB lookups inside the handler) through
    // to the real fetch so the handler's `users` SELECT still works.
    const fetchCalls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const selective = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://discord/')) {
        fetchCalls.push([input, init]);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return originalFetch(input, init);
    };
    global.fetch = selective as unknown as typeof fetch;
    try {
      const res = mockResponse();
      await handleFeedback(
        mockRequest({
          method: 'POST',
          cookies: { swu_session: cookie },
          body: {
            kind: 'price',
            message: 'TCGPlayer says $1.50',
            context: {
              productId: '12345',
              cardName: 'Luke Skywalker',
              variant: 'Showcase',
              ourPrice: 4,
              priceMode: 'market',
            },
          },
        }),
        res,
      );
      expect(res._status).toBe(204);

      // Wait a microtask for the fire-and-forget POST.
      await new Promise(r => setImmediate(r));

      expect(fetchCalls).toHaveLength(1);
      const [, init] = fetchCalls[0];
      const body = JSON.parse(init?.body as string);
      const description = body.embeds[0].description as string;
      // Reporter's handle (looked up from the session) is bolded.
      expect(description).toContain(`**@${viewer.handle}**`);
      // Card context survives the API → lib boundary.
      expect(description).toContain('`12345`');
      expect(description).toContain('Luke Skywalker');
      expect(description).toContain('$4.00');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects unknown context fields (strict zod schema)', async () => {
    const res = mockResponse();
    await handleFeedback(
      mockRequest({
        method: 'POST',
        body: {
          kind: 'price',
          message: 'hi',
          context: { productId: '1', wat: 'extra-field-not-allowed' },
        },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });
});
