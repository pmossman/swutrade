import { describe, expect, it } from 'vitest';
import {
  extractVariantLabel,
  extractBaseName,
  variantRank,
  variantBadgeColor,
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

  it('normalizes bare numeric parentheticals to Regional', () => {
    // SRP / OPP regional prize cards use the parenthetical for a
    // collector index, not a print variant.
    expect(extractVariantLabel('Karis Nemik - Freedom is a Pure Idea (77)'))
      .toBe('Regional');
    expect(extractVariantLabel('Mace Windu - Leaping into Action (69)'))
      .toBe('Regional');
  });

  it('preserves tournament-placement labels as-is', () => {
    expect(extractVariantLabel('Anakin Skywalker - Champion of Mortis (Finalist)'))
      .toBe('Finalist');
    expect(extractVariantLabel('Card (Top 8)')).toBe('Top 8');
    expect(extractVariantLabel('Card (Champion)')).toBe('Champion');
  });
});

describe('variantBadgeColor', () => {
  const FALLBACK = 'bg-space-600 text-gray-300';

  it('returns distinct pills for every canonical print variant', () => {
    for (const v of ['Standard', 'Foil', 'Hyperspace', 'Hyperspace Foil', 'Prestige', 'Prestige Foil', 'Serialized', 'Showcase', 'Gold', 'Rose Gold']) {
      expect(variantBadgeColor(v)).not.toBe(FALLBACK);
    }
  });

  it('gives Gold and Rose Gold distinct colored pills', () => {
    expect(variantBadgeColor('Gold')).toContain('yellow');
    expect(variantBadgeColor('Rose Gold')).toContain('rose');
    expect(variantBadgeColor('Gold')).not.toBe(variantBadgeColor('Rose Gold'));
  });

  it('returns a dedicated pill for Regional', () => {
    expect(variantBadgeColor('Regional')).toContain('teal');
  });

  it('shares one tournament pill across all placement labels', () => {
    const placements = ['Champion', 'Finalist', 'Top 4', 'Top 8', 'Top 16', 'Day 2', 'Galactic Championship VIP'];
    const colors = new Set(placements.map(variantBadgeColor));
    expect(colors.size).toBe(1);
    expect([...colors][0]).not.toBe(FALLBACK);
  });

  it('falls back to the unknown pill for truly unrecognized labels', () => {
    expect(variantBadgeColor('Some Brand New Variant')).toBe(FALLBACK);
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

  it('places Gold and Rose Gold after Serialized but before Showcase', () => {
    expect(variantRank('Serialized')).toBeLessThan(variantRank('Gold'));
    expect(variantRank('Gold')).toBeLessThan(variantRank('Rose Gold'));
    expect(variantRank('Rose Gold')).toBeLessThan(variantRank('Showcase'));
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
