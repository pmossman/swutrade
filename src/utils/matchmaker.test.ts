import { describe, expect, it } from 'vitest';
import { computeMatch } from './matchmaker';
import type { CardVariant } from '../types';

function card(productId: string, set: string, name: string, variant: string, market: number): CardVariant {
  return {
    name: variant === 'Standard' ? name : `${name} (${variant})`,
    variant,
    printing: 'Normal',
    rarity: 'Common',
    number: '1',
    marketPrice: market,
    lowPrice: market * 0.8,
    set,
    setName: set,
    productId,
  };
}

const CARDS = [
  card('100', 'jtl', 'Luke Skywalker - Hero of Yavin', 'Standard', 0.10),
  card('101', 'jtl', 'Luke Skywalker - Hero of Yavin', 'Hyperspace', 0.15),
  card('200', 'law', 'Cad Bane - Now Its My Turn', 'Standard', 2.00),
  card('201', 'law', 'Cad Bane - Now Its My Turn', 'Hyperspace', 4.00),
  card('300', 'law', 'Zuckuss - Dangerous', 'Hyperspace', 0.94),
  card('400', 'sec', 'Darth Vader - Dark Lord', 'Standard', 5.00),
  card('401', 'sec', 'Darth Vader - Dark Lord', 'Hyperspace', 8.00),
];

describe('computeMatch', () => {
  it('finds cards I can offer that they want', () => {
    const result = computeMatch(
      [],
      [{ productId: '200', qty: 1 }],
      [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
      [],
      CARDS,
      'market',
      100,
    );
    expect(result.offering).toHaveLength(1);
    expect(result.offering[0].productId).toBe('200');
    expect(result.receiving).toHaveLength(0);
  });

  it('finds cards I can receive that I want from their available', () => {
    const result = computeMatch(
      [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
      [],
      [],
      [{ productId: '201', qty: 1 }],
      CARDS,
      'market',
      100,
    );
    expect(result.receiving).toHaveLength(1);
    expect(result.receiving[0].productId).toBe('201');
    expect(result.offering).toHaveLength(0);
  });

  it('balances a mutual trade', () => {
    const result = computeMatch(
      // I want Darth Vader
      [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
      // I have Cad Bane Hyper + Zuckuss
      [{ productId: '201', qty: 1 }, { productId: '300', qty: 1 }],
      // They want Cad Bane
      [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
      // They have Darth Vader
      [{ productId: '400', qty: 1 }],
      CARDS,
      'market',
      100,
    );
    // Should offer Cad Bane Hyper ($4) and receive Darth Vader Standard ($5).
    expect(result.offering.length).toBeGreaterThan(0);
    expect(result.receiving.length).toBeGreaterThan(0);
    // Both sides should have some value.
    expect(result.offeringTotal).toBeGreaterThan(0);
    expect(result.receivingTotal).toBeGreaterThan(0);
    // Should be roughly balanced (within $2 for this small trade).
    expect(Math.abs(result.offeringTotal - result.receivingTotal)).toBeLessThan(2);
  });

  it('respects variant restrictions', () => {
    const result = computeMatch(
      [],
      [{ productId: '200', qty: 1 }, { productId: '201', qty: 1 }],
      // They want Cad Bane but only Hyperspace.
      [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'restricted', variants: ['Hyperspace'] } }],
      [],
      CARDS,
      'market',
      100,
    );
    // Should only offer the Hyperspace variant, not Standard.
    expect(result.offering).toHaveLength(1);
    expect(result.offering[0].productId).toBe('201');
  });

  it('returns empty when there is no overlap', () => {
    const result = computeMatch(
      [{ familyId: 'jtl::luke-skywalker-hero-of-yavin', qty: 1, restriction: { mode: 'any' } }],
      [{ productId: '200', qty: 1 }],
      [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
      [{ productId: '300', qty: 1 }],
      CARDS,
      'market',
      100,
    );
    // No overlap: I have Cad Bane but they want Vader; they have Zuckuss but I want Luke.
    expect(result.offering).toHaveLength(0);
    expect(result.receiving).toHaveLength(0);
  });

  it('reports total overlap counts', () => {
    const result = computeMatch(
      [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
      [{ productId: '400', qty: 1 }],
      [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
      [{ productId: '200', qty: 1 }],
      CARDS,
      'market',
      100,
    );
    expect(result.overlapOffering).toBe(1);
    expect(result.overlapReceiving).toBe(1);
  });
});
