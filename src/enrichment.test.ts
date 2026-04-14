import { describe, expect, it } from 'vitest';
import type { CardVariant } from './types';
import {
  normalizeCardNumber,
  canonicalId,
  buildLookup,
  enrichCard,
  normalizeCardType,
  type SwuApiCard,
} from './enrichment';

function swuCard(overrides: Partial<SwuApiCard>): SwuApiCard {
  return {
    uuid: 'u-1',
    externalId: 1,
    id: 'SOR_005',
    name: 'Luke Skywalker',
    subtitle: 'Faithful Friend',
    setCode: 'SOR',
    cardNumber: '5',
    type: 'Leader',
    variantType: 'Standard',
    aspects: ['Heroism', 'Command'],
    traits: ['Rebel'],
    isLeader: true,
    isBase: false,
    ...overrides,
  };
}

function tcgCard(overrides: Partial<CardVariant>): CardVariant {
  return {
    name: 'Luke Skywalker - Faithful Friend',
    variant: 'Standard',
    printing: 'Normal',
    rarity: 'Legendary',
    number: '5',
    marketPrice: 10,
    lowPrice: 8,
    set: 'spark-of-rebellion',
    setName: 'Spark of Rebellion',
    productId: '1001',
    ...overrides,
  };
}

describe('normalizeCardNumber', () => {
  it('keeps plain numbers untouched', () => {
    expect(normalizeCardNumber('5')).toBe('5');
    expect(normalizeCardNumber('123')).toBe('123');
  });

  it('strips the /total suffix', () => {
    expect(normalizeCardNumber('224/264')).toBe('224');
  });

  it('strips leading zeros but preserves "0"', () => {
    expect(normalizeCardNumber('005')).toBe('5');
    expect(normalizeCardNumber('0')).toBe('0');
  });

  it('handles empty strings without throwing', () => {
    expect(normalizeCardNumber('')).toBe('');
  });
});

describe('canonicalId', () => {
  it('uppercases the set code and normalizes the number', () => {
    expect(canonicalId('sor', '005')).toBe('SOR_5');
    expect(canonicalId('LAW', '100/252')).toBe('LAW_100');
  });
});

describe('buildLookup', () => {
  it('prefers Standard variants for metadata when multiple are present', () => {
    const lookup = buildLookup([
      swuCard({ uuid: 'a', variantType: 'Hyperspace', id: 'SOR_5' }),
      swuCard({ uuid: 'b', variantType: 'Standard',   id: 'SOR_5' }),
      swuCard({ uuid: 'c', variantType: 'Showcase',   id: 'SOR_5' }),
    ]);
    expect(lookup.byCanonicalId.get('SOR_5')?.uuid).toBe('b');
  });

  it('falls back to first seen when no Standard variant exists', () => {
    const lookup = buildLookup([
      swuCard({ uuid: 'a', variantType: 'Hyperspace', cardNumber: '9', id: 'SOR_9' }),
      swuCard({ uuid: 'b', variantType: 'Showcase',   cardNumber: '9', id: 'SOR_9' }),
    ]);
    expect(lookup.byCanonicalId.get('SOR_9')?.uuid).toBe('a');
  });
});

describe('normalizeCardType', () => {
  it('maps known types', () => {
    expect(normalizeCardType('Leader')).toBe('Leader');
    expect(normalizeCardType('Unit')).toBe('Unit');
    expect(normalizeCardType('Token Upgrade')).toBe('Token Upgrade');
  });

  it('returns undefined for unknown types (no silent coercion)', () => {
    expect(normalizeCardType('Banana')).toBeUndefined();
    expect(normalizeCardType(undefined)).toBeUndefined();
  });
});

describe('enrichCard', () => {
  const slugToCode = { 'spark-of-rebellion': 'SOR' };
  const lookup = buildLookup([swuCard({})]);

  it('adds baseCardId + metadata on match', () => {
    const enriched = enrichCard(tcgCard({}), lookup, { slugToCode });
    expect(enriched.baseCardId).toBe('SOR_005');
    expect(enriched.displayName).toBe('Luke Skywalker - Faithful Friend');
    expect(enriched.cardType).toBe('Leader');
    expect(enriched.aspects).toEqual(['Heroism', 'Command']);
    expect(enriched.traits).toEqual(['Rebel']);
  });

  it('synthesizes baseCardId when the set has no code mapping', () => {
    const enriched = enrichCard(
      tcgCard({ set: 'unknown-set', number: '42' }),
      lookup,
      { slugToCode },
    );
    expect(enriched.baseCardId).toBe('unknown-set:luke-skywalker-faithful-friend');
    expect(enriched.displayName).toBeUndefined();
    expect(enriched.cardType).toBeUndefined();
  });

  it('synthesizes baseCardId when no swuapi match found', () => {
    const enriched = enrichCard(
      tcgCard({ number: '999' }),
      lookup,
      { slugToCode },
    );
    expect(enriched.baseCardId).toBe('spark-of-rebellion:luke-skywalker-faithful-friend');
    expect(enriched.displayName).toBeUndefined();
  });

  it('tolerates zero-padded TCGPlayer numbers', () => {
    const enriched = enrichCard(
      tcgCard({ number: '005' }),
      lookup,
      { slugToCode },
    );
    expect(enriched.baseCardId).toBe('SOR_005');
  });

  it('tolerates fractional collector numbers', () => {
    const enriched = enrichCard(
      tcgCard({ number: '5/252' }),
      lookup,
      { slugToCode },
    );
    expect(enriched.baseCardId).toBe('SOR_005');
  });
});
