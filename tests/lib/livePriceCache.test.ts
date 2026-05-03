import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __resetLivePriceCache,
  resolveLivePrices,
} from '../../lib/livePriceCache.js';

/**
 * Coverage for the server-side live-price cache. The contract
 * matters more than the wire shape:
 *   1. cache hit → no upstream call.
 *   2. concurrent calls for the same uncached id → one upstream call.
 *   3. mixed cache hit + miss → batched call only for the misses.
 *   4. unknown / 404 productIds simply absent from the result.
 *   5. upstream failure → empty result; never throws.
 *
 * We mock fetch by passing a `fetchImpl` argument so the lib stays
 * pure / no `vi.spyOn` global state to clean up.
 */

function mockBatchResponse(prices: Array<{ productId: string; market: number | null; low: number | null }>) {
  return new Response(
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
  );
}

describe('resolveLivePrices', () => {
  beforeEach(() => {
    __resetLivePriceCache();
  });

  it('returns prices from a single batched upstream call', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockBatchResponse([
      { productId: '111', market: 1.5, low: 1.0 },
      { productId: '222', market: 5.0, low: 3.5 },
    ]));
    const out = await resolveLivePrices(['111', '222'], fetchSpy as unknown as typeof fetch);
    expect(out.size).toBe(2);
    expect(out.get('111')?.marketPrice).toBe(1.5);
    expect(out.get('222')?.lowPrice).toBe(3.5);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caches fresh entries — second call within TTL skips upstream', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockBatchResponse([
      { productId: '111', market: 1.5, low: 1.0 },
    ]));
    await resolveLivePrices(['111'], fetchSpy as unknown as typeof fetch);
    await resolveLivePrices(['111'], fetchSpy as unknown as typeof fetch);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('mixed cache hit + miss only sends missing ids upstream', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockBatchResponse([
      { productId: '111', market: 1.5, low: 1.0 },
    ]));
    await resolveLivePrices(['111'], fetchSpy as unknown as typeof fetch);

    fetchSpy.mockResolvedValueOnce(mockBatchResponse([
      { productId: '222', market: 5.0, low: 3.5 },
    ]));
    const out = await resolveLivePrices(['111', '222'], fetchSpy as unknown as typeof fetch);
    // 111 served from cache, 222 missed → one batch call for [222].
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(secondCallBody.filters.term.productId).toEqual(['222']);
    expect(out.get('111')?.marketPrice).toBe(1.5);
    expect(out.get('222')?.marketPrice).toBe(5.0);
  });

  it('dedups concurrent calls — same id requested twice in one tick = one upstream', async () => {
    let resolveBatch: (r: Response) => void = () => {};
    const fetchSpy = vi.fn().mockReturnValue(new Promise(r => { resolveBatch = r; }));
    // Kick off two parallel calls for the same id — neither awaited yet.
    const a = resolveLivePrices(['111'], fetchSpy as unknown as typeof fetch);
    const b = resolveLivePrices(['111'], fetchSpy as unknown as typeof fetch);
    // Resolve the upstream once; both promises should converge.
    resolveBatch(mockBatchResponse([{ productId: '111', market: 1.5, low: 1.0 }]));
    const [outA, outB] = await Promise.all([a, b]);
    expect(outA.get('111')?.marketPrice).toBe(1.5);
    expect(outB.get('111')?.marketPrice).toBe(1.5);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('unknown productIds (no row in upstream response) absent from result', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockBatchResponse([
      // upstream returns just '111' even though we asked for '111' + '999'
      { productId: '111', market: 1.5, low: 1.0 },
    ]));
    const out = await resolveLivePrices(['111', '999'], fetchSpy as unknown as typeof fetch);
    expect(out.has('111')).toBe(true);
    expect(out.has('999')).toBe(false);
  });

  it('TCGPlayer null lowestPrice surfaces as null in the LivePrice (caller falls back)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockBatchResponse([
      { productId: '111', market: 5.0, low: null },
    ]));
    const out = await resolveLivePrices(['111'], fetchSpy as unknown as typeof fetch);
    expect(out.get('111')?.marketPrice).toBe(5.0);
    expect(out.get('111')?.lowPrice).toBeNull();
  });

  it('upstream network failure → empty result, never throws', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'));
    const out = await resolveLivePrices(['111'], fetchSpy as unknown as typeof fetch);
    expect(out.size).toBe(0);
  });

  it('upstream non-2xx → empty result, never throws', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
    const out = await resolveLivePrices(['111'], fetchSpy as unknown as typeof fetch);
    expect(out.size).toBe(0);
  });

  it('empty input → empty result, no upstream call', async () => {
    const fetchSpy = vi.fn();
    const out = await resolveLivePrices([], fetchSpy as unknown as typeof fetch);
    expect(out.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
