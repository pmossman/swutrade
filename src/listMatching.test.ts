import { describe, expect, it } from 'vitest';
import type { CardVariant } from './types';
import type { WantsItem } from './persistence';
import { matchesRestriction, bestMatchForWant } from './listMatching';

function card(name: string, priceMarket: number | null = 1): CardVariant {
  return {
    name,
    variant: 'Standard',
    printing: 'Normal',
    rarity: 'Common',
    number: '001',
    marketPrice: priceMarket,
    lowPrice: priceMarket,
    set: 'test',
    setName: 'Test',
    productId: name,
  };
}

function want(restriction: WantsItem['restriction']): WantsItem {
  return {
    id: 'w_1',
    baseCardId: 'TEST_1',
    qty: 1,
    restriction,
    addedAt: 0,
  };
}

describe('matchesRestriction', () => {
  it('any mode matches every variant', () => {
    expect(matchesRestriction(card('Foo (Hyperspace)'), { mode: 'any' })).toBe(true);
    expect(matchesRestriction(card('Foo'), { mode: 'any' })).toBe(true);
  });

  it('restricted mode matches only listed variants', () => {
    const r = { mode: 'restricted' as const, variants: ['Hyperspace', 'Showcase'] as const };
    expect(matchesRestriction(card('Foo (Hyperspace)'), r)).toBe(true);
    expect(matchesRestriction(card('Foo (Showcase)'), r)).toBe(true);
    expect(matchesRestriction(card('Foo'), r)).toBe(false); // Standard
    expect(matchesRestriction(card('Foo (Foil)'), r)).toBe(false);
  });
});

describe('bestMatchForWant', () => {
  it('returns the cheapest matching variant', () => {
    const candidates = [
      card('Foo', 5),
      card('Foo (Hyperspace)', 2),
      card('Foo (Showcase)', 20),
    ];
    const result = bestMatchForWant(want({ mode: 'any' }), candidates, 'market');
    expect(result?.name).toBe('Foo (Hyperspace)');
  });

  it('respects a restricted restriction when picking', () => {
    const candidates = [
      card('Foo', 0.5),            // Standard, cheapest overall
      card('Foo (Hyperspace)', 2), // matches
      card('Foo (Showcase)', 20),  // matches
    ];
    const restriction = { mode: 'restricted' as const, variants: ['Hyperspace', 'Showcase'] as const };
    const result = bestMatchForWant(want(restriction), candidates, 'market');
    expect(result?.name).toBe('Foo (Hyperspace)');
  });

  it('returns null when nothing matches', () => {
    const candidates = [card('Foo', 1)];
    const restriction = { mode: 'restricted' as const, variants: ['Showcase'] as const };
    expect(bestMatchForWant(want(restriction), candidates, 'market')).toBeNull();
  });

  it('treats null prices as worse than any real price', () => {
    const candidates = [
      card('Foo', null), // no price — should lose even though technically "cheapest"
      card('Foo (Hyperspace)', 10),
    ];
    const result = bestMatchForWant(want({ mode: 'any' }), candidates, 'market');
    expect(result?.name).toBe('Foo (Hyperspace)');
  });
});
