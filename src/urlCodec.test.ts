import { describe, expect, it } from 'vitest';
import type { TradeCard, CardVariant } from './types';
import {
  buildTradeSearch,
  parseTradeUrl,
  encodeCards,
  decodeCardRefs,
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
});
