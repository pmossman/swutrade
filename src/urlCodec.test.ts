import { describe, expect, it } from 'vitest';
import type { TradeCard, CardVariant } from './types';
import {
  buildTradeSearch,
  parseTradeUrl,
  encodeCards,
  decodeCardRefs,
  encodeWants,
  decodeWants,
  encodeAvailable,
  decodeAvailable,
  variantsToMask,
  maskToVariants,
  type WantsUrlEntry,
  type AvailableUrlEntry,
} from './urlCodec';

function makeCard(productId: string, name = 'Test'): CardVariant {
  return {
    name,
    variant: 'Standard',
    printing: 'Normal',
    rarity: 'Common',
    number: '001',
    marketPrice: 1,
    lowPrice: 1,
    set: 'test',
    setName: 'Test',
    productId,
  };
}

function tc(productId: string, qty: number): TradeCard {
  return { card: makeCard(productId), qty };
}

describe('urlCodec', () => {
  it('round-trips trade state through encode → parse', () => {
    const state = {
      yourCards: [tc('1001', 2), tc('1002', 1)],
      theirCards: [tc('2001', 3)],
      percentage: 75,
      priceMode: 'low' as const,
    };

    const search = buildTradeSearch(state);
    const parsed = parseTradeUrl(search);
    expect(parsed).not.toBeNull();
    expect(parsed!.pending.yours).toEqual([
      { productId: '1001', qty: 2 },
      { productId: '1002', qty: 1 },
    ]);
    expect(parsed!.pending.theirs).toEqual([{ productId: '2001', qty: 3 }]);
    expect(parsed!.percentage).toBe(75);
    expect(parsed!.priceMode).toBe('low');
  });

  it('returns null for a URL with no trade params', () => {
    expect(parseTradeUrl('')).toBeNull();
    expect(parseTradeUrl('foo=bar')).toBeNull();
  });

  it('omits pct/pm on empty-trade URLs when at defaults', () => {
    const search = buildTradeSearch({
      yourCards: [],
      theirCards: [],
      percentage: 80,
      priceMode: 'market',
    });
    expect(search).toBe('');
  });

  it('always encodes pct/pm when a trade is present', () => {
    const search = buildTradeSearch({
      yourCards: [tc('1001', 1)],
      theirCards: [],
      percentage: 80,
      priceMode: 'market',
    });
    const params = new URLSearchParams(search);
    expect(params.get('pct')).toBe('80');
    expect(params.get('pm')).toBe('m');
  });

  it('drops cards without productId from encode', () => {
    const cardNoId: TradeCard = {
      card: { ...makeCard('x'), productId: undefined },
      qty: 1,
    };
    expect(encodeCards([cardNoId, tc('1001', 2)])).toBe('1001.2');
  });

  it('decodes gracefully when qty is malformed', () => {
    expect(decodeCardRefs('1001.notanumber')).toEqual([
      { productId: '1001', qty: 1 },
    ]);
  });

  it('clamps pct to [1, 100]', () => {
    expect(parseTradeUrl('y=1001.1&pct=999')!.percentage).toBe(100);
    expect(parseTradeUrl('y=1001.1&pct=0')!.percentage).toBe(1);
    expect(parseTradeUrl('y=1001.1&pct=-5')!.percentage).toBe(1);
    expect(parseTradeUrl('y=1001.1&pct=50')!.percentage).toBe(50);
  });
});

describe('variantsToMask / maskToVariants', () => {
  it('round-trips a single variant', () => {
    const m = variantsToMask(['Hyperspace']);
    expect(maskToVariants(m)).toEqual(['Hyperspace']);
  });

  it('round-trips multiple variants in canonical order', () => {
    const m = variantsToMask(['Showcase', 'Standard', 'Hyperspace']);
    // Decoded order matches CANONICAL_VARIANTS regardless of input order.
    expect(maskToVariants(m)).toEqual(['Standard', 'Hyperspace', 'Showcase']);
  });

  it('Standard maps to bit 0', () => {
    expect(variantsToMask(['Standard'])).toBe(0b1);
  });

  it('Showcase maps to bit 7', () => {
    expect(variantsToMask(['Showcase'])).toBe(0b10000000);
  });

  it('Gold and Rose Gold land in the appended slots (backward-compat)', () => {
    // Appended after Showcase so pre-existing share URLs with masks
    // <= 0xff continue to decode to the same print variants.
    expect(variantsToMask(['Gold'])).toBe(0b100000000);
    expect(variantsToMask(['Rose Gold'])).toBe(0b1000000000);
    expect(maskToVariants(0b100000000)).toEqual(['Gold']);
    expect(maskToVariants(0b1000000000)).toEqual(['Rose Gold']);
  });
});

describe('encodeWants / decodeWants', () => {
  const wants: WantsUrlEntry[] = [
    {
      familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin',
      qty: 2,
      restriction: { mode: 'any' },
      isPriority: true,
    },
    {
      familyId: 'a-lawless-time::darth-vader-unstoppable',
      qty: 1,
      restriction: { mode: 'restricted', variants: ['Hyperspace', 'Showcase'] },
    },
  ];

  it('round-trips wants through encode → decode', () => {
    const encoded = encodeWants(wants);
    const decoded = decodeWants(encoded);
    expect(decoded).toEqual(wants);
  });

  it('produces a compressed output starting with ~', () => {
    const encoded = encodeWants([wants[0]]);
    // Compressed params start with ~ and contain base64url characters.
    expect(encoded.startsWith('~')).toBe(true);
    // FamilyId's "::" shouldn't leak into the compressed output.
    expect(encoded).not.toContain('::');
  });

  it('decodes legacy uncompressed params (backward compat)', () => {
    // Old-format URLs without the ~ prefix still work.
    const legacy = 'jump-to-lightspeed%3A%3Aluke-skywalker-hero-of-yavin.2.r4.p';
    const decoded = decodeWants(legacy);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].familyId).toBe('jump-to-lightspeed::luke-skywalker-hero-of-yavin');
    expect(decoded[0].qty).toBe(2);
    expect(decoded[0].isPriority).toBe(true);
  });

  it('omits restriction segment for any-mode items', () => {
    const encoded = encodeWants([{
      familyId: 'set::card',
      qty: 1,
      restriction: { mode: 'any' },
    }]);
    // No ".r" segment should appear
    expect(encoded.includes('.r')).toBe(false);
  });

  it('omits priority segment for non-priority items', () => {
    const encoded = encodeWants([{
      familyId: 'set::card',
      qty: 1,
      restriction: { mode: 'any' },
    }]);
    expect(encoded.endsWith('.p')).toBe(false);
  });

  it('returns empty array for blank input', () => {
    expect(decodeWants('')).toEqual([]);
  });

  it('caps qty at 99 and floors at 1', () => {
    const decoded = decodeWants('set%3A%3Acard.500,set%3A%3Aother.0');
    expect(decoded[0].qty).toBe(99);
    expect(decoded[1].qty).toBe(1);
  });

  it('skips entries with malformed familyId', () => {
    // Single-segment entry has no qty
    const decoded = decodeWants('set%3A%3Acard,real%3A%3Aone.2');
    expect(decoded).toHaveLength(1);
    expect(decoded[0].familyId).toBe('real::one');
  });
});

describe('encodeAvailable / decodeAvailable', () => {
  it('round-trips available through encode → decode', () => {
    const items: AvailableUrlEntry[] = [
      { productId: '540213', qty: 3 },
      { productId: '617180', qty: 1 },
    ];
    const decoded = decodeAvailable(encodeAvailable(items));
    expect(decoded).toEqual(items);
  });

  it('caps qty at 99 and floors at 1', () => {
    const decoded = decodeAvailable('111.500,222.0');
    expect(decoded[0].qty).toBe(99);
    expect(decoded[1].qty).toBe(1);
  });

  it('returns empty array for blank input', () => {
    expect(decodeAvailable('')).toEqual([]);
  });
});
