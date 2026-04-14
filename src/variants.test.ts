import { describe, expect, it } from 'vitest';
import {
  extractVariantLabel,
  extractBaseName,
  variantRank,
  isLeaderOrBaseGroup,
  synthesizeBaseCardId,
} from './variants';

describe('extractVariantLabel', () => {
  it('returns Standard when no parenthetical is present', () => {
    expect(extractVariantLabel('Liberty - Draw Their Fire!')).toBe('Standard');
  });

  it('pulls the variant from a trailing parenthetical', () => {
    expect(extractVariantLabel('Liberty - Draw Their Fire! (Hyperspace Foil)'))
      .toBe('Hyperspace Foil');
    expect(extractVariantLabel('Card (Showcase)')).toBe('Showcase');
  });
});

describe('extractBaseName', () => {
  it('strips trailing variant parenthetical', () => {
    expect(extractBaseName('Liberty - Draw Their Fire! (Hyperspace)'))
      .toBe('Liberty - Draw Their Fire!');
  });

  it('leaves card names without suffix alone', () => {
    expect(extractBaseName('Luke Skywalker - Faithful Friend'))
      .toBe('Luke Skywalker - Faithful Friend');
  });
});

describe('variantRank', () => {
  it('orders canonical variants correctly', () => {
    expect(variantRank('Standard')).toBeLessThan(variantRank('Foil'));
    expect(variantRank('Foil')).toBeLessThan(variantRank('Hyperspace'));
    expect(variantRank('Hyperspace Foil')).toBeLessThan(variantRank('Prestige'));
    expect(variantRank('Serialized')).toBeLessThan(variantRank('Showcase'));
  });

  it('sorts unknown variants before Showcase but after known', () => {
    const unknown = variantRank('Something New');
    expect(unknown).toBeGreaterThan(variantRank('Serialized'));
    expect(unknown).toBeLessThan(variantRank('Showcase'));
  });
});

describe('isLeaderOrBaseGroup', () => {
  it('uses cardType: Leader when enrichment is available', () => {
    expect(isLeaderOrBaseGroup([
      { name: 'Foo (Standard)', cardType: 'Leader' },
      { name: 'Foo (Hyperspace)', cardType: 'Leader' },
    ])).toBe(true);
  });

  it('uses cardType: Base when enrichment is available', () => {
    expect(isLeaderOrBaseGroup([
      { name: 'Foo (Standard)', cardType: 'Base' },
    ])).toBe(true);
  });

  it('returns false for Unit cards even when a Showcase variant exists', () => {
    // Regression: legacy heuristic misflagged Darth Vader - Unstoppable
    // (a Unit with a Showcase printing) as a leader/landscape card.
    expect(isLeaderOrBaseGroup([
      { name: 'Unstoppable (Standard)', cardType: 'Unit' },
      { name: 'Unstoppable (Showcase)', cardType: 'Unit' },
    ])).toBe(false);
  });

  it('falls back to Showcase heuristic when cardType is unavailable', () => {
    expect(isLeaderOrBaseGroup([
      { name: 'Foo (Standard)' },
      { name: 'Foo (Showcase)' },
    ])).toBe(true);
    expect(isLeaderOrBaseGroup([
      { name: 'Foo (Standard)' },
      { name: 'Foo (Hyperspace)' },
    ])).toBe(false);
  });

  it('prefers cardType over heuristic when mixed (first card typed)', () => {
    // Even one typed variant activates the cardType path; the Showcase
    // heuristic no longer gets a vote. This is the desired behavior —
    // partial enrichment should still correctly classify the group.
    expect(isLeaderOrBaseGroup([
      { name: 'Foo (Standard)', cardType: 'Unit' },
      { name: 'Foo (Showcase)' },
    ])).toBe(false);
  });
});

describe('synthesizeBaseCardId', () => {
  it('produces a stable slug from set + base name', () => {
    const id = synthesizeBaseCardId({
      name: "Liberty - Draw Their Fire! (Hyperspace)",
      variant: 'Hyperspace',
      printing: 'Normal',
      rarity: 'Common',
      number: '001',
      marketPrice: 1,
      lowPrice: 1,
      set: 'a-lawless-time',
      setName: 'A Lawless Time',
    });
    expect(id).toBe('a-lawless-time:liberty-draw-their-fire');
  });
});
