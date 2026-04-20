import { describe, it, expect } from 'vitest';
import { encodeWants, encodeAvailable } from '../../src/urlCodec.js';
import type { WantsItem, AvailableItem } from '../../src/persistence/index.js';
import { decodeWants, decodeAvailableRefs } from '../../lib/listShareCodec.js';

/**
 * Cross-boundary round-trip tests for the list-image share flow.
 *
 * The class of bug this closes: `src/urlCodec.ts` encodes wants +
 * available share-URL params with deflate + base64url compression
 * (added 2026-04-15, commit `43b7fec`). The server-side decoder
 * (originally inlined in `api/og.ts`, now `lib/listShareCodec.ts`)
 * used to duplicate the uncompressed parse logic without the
 * matching `decompressParam` step, silently returning `[]` for every
 * modern share link → empty image.
 *
 * The existing `src/urlCodec.test.ts` suite tested encode/decode on
 * the CLIENT only — both sides of the assert used the client codec,
 * so the divergence at the client/server boundary was invisible.
 * These tests assert equivalence ACROSS that boundary, which is what
 * would have caught the bug.
 */

function makeWant(overrides: Partial<WantsItem> = {}): WantsItem {
  return {
    id: 'w-1',
    familyId: 'luke-skywalker-hero-of-yavin',
    qty: 2,
    restriction: { mode: 'any' },
    addedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeAvailable(overrides: Partial<AvailableItem> = {}): AvailableItem {
  return {
    id: 'a-1',
    productId: '123456',
    qty: 3,
    addedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('api/og list-image codec round-trip', () => {
  it('wants: single any-variant item survives compress → decompress', () => {
    const input = [makeWant()];
    const encoded = encodeWants(input);
    expect(encoded.startsWith('~')).toBe(true); // sanity: compressed
    const decoded = decodeWants(encoded);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({
      familyId: 'luke-skywalker-hero-of-yavin',
      qty: 2,
      acceptedVariants: null,
      isPriority: false,
    });
  });

  it('wants: priority + restricted variants survive round-trip', () => {
    const input = [
      makeWant({
        id: 'w-1',
        familyId: 'vader-dark-lord',
        qty: 1,
        restriction: { mode: 'restricted', variants: ['Hyperspace Foil'] },
        isPriority: true,
      }),
    ];
    const encoded = encodeWants(input);
    const decoded = decodeWants(encoded);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].familyId).toBe('vader-dark-lord');
    expect(decoded[0].qty).toBe(1);
    expect(decoded[0].isPriority).toBe(true);
    expect(decoded[0].acceptedVariants).toEqual(['Hyperspace Foil']);
  });

  it('wants: many items survive (the bug manifested on real-sized lists)', () => {
    const input = Array.from({ length: 20 }, (_, i) =>
      makeWant({
        id: `w-${i}`,
        familyId: `card-${i}`,
        qty: (i % 3) + 1,
        isPriority: i % 5 === 0,
      }),
    );
    const encoded = encodeWants(input);
    expect(encoded.startsWith('~')).toBe(true);
    const decoded = decodeWants(encoded);
    expect(decoded).toHaveLength(20);
    expect(decoded.map(d => d.familyId)).toEqual(input.map(w => w.familyId));
  });

  it('wants: empty input yields empty output', () => {
    expect(decodeWants(encodeWants([]))).toEqual([]);
  });

  it('available: single item survives round-trip', () => {
    const input = [makeAvailable()];
    const encoded = encodeAvailable(input);
    expect(encoded.startsWith('~')).toBe(true);
    const decoded = decodeAvailableRefs(encoded);
    expect(decoded).toEqual([{ productId: '123456', qty: 3 }]);
  });

  it('available: many items survive round-trip', () => {
    const input = Array.from({ length: 15 }, (_, i) =>
      makeAvailable({ id: `a-${i}`, productId: `p-${i}`, qty: i + 1 }),
    );
    const encoded = encodeAvailable(input);
    const decoded = decodeAvailableRefs(encoded);
    expect(decoded).toHaveLength(15);
    expect(decoded[0]).toEqual({ productId: 'p-0', qty: 1 });
    expect(decoded[14]).toEqual({ productId: 'p-14', qty: 15 });
  });

  it('legacy uncompressed wants param still decodes (backward compat)', () => {
    // Pre-43b7fec share links predate compression and still circulate
    // in Discord messages. They should decode unchanged. Uncompressed
    // payloads don't carry the `~` prefix; decodeWants must pass them
    // through decompressParam unchanged.
    const legacy = 'luke-jtl.2,vader-dark-lord.1.p';
    const decoded = decodeWants(legacy);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject({ familyId: 'luke-jtl', qty: 2, isPriority: false });
    expect(decoded[1]).toMatchObject({ familyId: 'vader-dark-lord', qty: 1, isPriority: true });
  });

  it('legacy uncompressed available param still decodes', () => {
    const legacy = '123456.3,789012.1';
    expect(decodeAvailableRefs(legacy)).toEqual([
      { productId: '123456', qty: 3 },
      { productId: '789012', qty: 1 },
    ]);
  });

  it('malformed input returns empty, does not throw', () => {
    expect(decodeWants('~not-base64-!!!@@@')).toEqual([]);
    expect(decodeAvailableRefs('~not-base64-!!!@@@')).toEqual([]);
  });
});
