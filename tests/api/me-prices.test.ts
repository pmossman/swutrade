import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handlePrices } from '../../api/me.js';
import { __resetLivePriceCache } from '../../lib/livePriceCache.js';
import { mockRequest, mockResponse } from './helpers.js';

/**
 * Coverage for /api/me/prices (rewritten as /api/prices). Validates
 * the API contract:
 *   - GET-only.
 *   - Validates ids query param (non-empty, ≤50, numeric-string only).
 *   - Returns the cache lib's results keyed by productId.
 *   - Cache-Control prevents intermediate caching.
 *
 * Cache is reset between cases so test ordering doesn't matter.
 * Selective fetch mock intercepts only the TCGPlayer URL — leaves
 * everything else alone (these tests don't touch the DB but the
 * pattern matches the feedback test).
 */
describe('GET /api/me/prices', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    __resetLivePriceCache();
    originalFetch = global.fetch;
  });

  function withMockedFetch<T>(prices: Array<{ productId: string; market: number | null; low: number | null }>, fn: () => Promise<T>): Promise<T> {
    const selective = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('mp-search-api.tcgplayer.com')) {
        return Promise.resolve(new Response(
          JSON.stringify({
            results: [{
              totalResults: prices.length,
              results: prices.map(p => ({
                productId: Number(p.productId),
                marketPrice: p.market,
                lowestPrice: p.low,
              })),
            }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ));
      }
      return originalFetch(input, init);
    };
    global.fetch = selective as unknown as typeof fetch;
    return fn().finally(() => {
      global.fetch = originalFetch;
    });
  }

  it('rejects non-GET methods with 405', async () => {
    const res = mockResponse();
    await handlePrices(mockRequest({ method: 'POST', query: { ids: '111' } }), res);
    expect(res._status).toBe(405);
    expect(res._headers.allow).toBe('GET');
  });

  it('rejects missing ids with 400', async () => {
    const res = mockResponse();
    await handlePrices(mockRequest({ method: 'GET', query: {} }), res);
    expect(res._status).toBe(400);
  });

  it('rejects too many ids with 400', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => String(100 + i)).join(',');
    const res = mockResponse();
    await handlePrices(mockRequest({ method: 'GET', query: { ids } }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/Too many/);
  });

  it('rejects non-numeric productIds with 400 (cheap boundary guard)', async () => {
    const res = mockResponse();
    await handlePrices(mockRequest({ method: 'GET', query: { ids: '111,abc,222' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns prices keyed by productId for the happy path', async () => {
    await withMockedFetch(
      [
        { productId: '111', market: 1.5, low: 1.0 },
        { productId: '222', market: 5.0, low: 3.5 },
      ],
      async () => {
        const res = mockResponse();
        await handlePrices(
          mockRequest({ method: 'GET', query: { ids: '111,222' } }),
          res,
        );
        expect(res._status).toBe(200);
        const json = res._json as { prices: Record<string, { marketPrice: number; lowPrice: number; fetchedAt: string }> };
        expect(json.prices['111'].marketPrice).toBe(1.5);
        expect(json.prices['111'].lowPrice).toBe(1.0);
        expect(json.prices['222'].marketPrice).toBe(5.0);
        expect(typeof json.prices['111'].fetchedAt).toBe('string');
        // private, no-store: stops CDNs from caching freshness data.
        expect(res._headers['cache-control']).toBe('private, no-store');
      },
    );
  });

  it('omits productIds the upstream had no row for (caller falls back to static)', async () => {
    await withMockedFetch(
      [{ productId: '111', market: 1.5, low: 1.0 }],
      async () => {
        const res = mockResponse();
        await handlePrices(
          mockRequest({ method: 'GET', query: { ids: '111,999' } }),
          res,
        );
        expect(res._status).toBe(200);
        const json = res._json as { prices: Record<string, unknown> };
        expect(Object.keys(json.prices)).toEqual(['111']);
      },
    );
  });

  it('dedups duplicates in the ids param without fanning out the upstream call', async () => {
    let upstreamCalls = 0;
    const selective = (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('mp-search-api.tcgplayer.com')) {
        upstreamCalls += 1;
        return Promise.resolve(new Response(
          JSON.stringify({
            results: [{
              totalResults: 1,
              results: [{ productId: 111, marketPrice: 1.5, lowestPrice: 1.0 }],
            }],
          }),
          { status: 200 },
        ));
      }
      return originalFetch(input);
    };
    global.fetch = selective as unknown as typeof fetch;
    try {
      const res = mockResponse();
      // Three duplicate ids — should still be ONE upstream call with one id.
      await handlePrices(
        mockRequest({ method: 'GET', query: { ids: '111,111,111' } }),
        res,
      );
      expect(res._status).toBe(200);
      expect(upstreamCalls).toBe(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
