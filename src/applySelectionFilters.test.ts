import { describe, expect, it } from 'vitest';
import type { CardVariant } from './types';
import type { SetSearchGroup } from './hooks/useCardSearch';
import {
  applySelectionFilters,
  MAIN_GROUP,
  SPECIAL_GROUP,
} from './applySelectionFilters';

function card(
  set: string,
  name: string,
  overrides: Partial<CardVariant> = {},
): CardVariant {
  return {
    name,
    variant: 'Standard',
    printing: 'Normal',
    rarity: 'Common',
    number: '001',
    marketPrice: 1,
    lowPrice: 1,
    set,
    setName: set,
    ...overrides,
  };
}

function group(set: string, setCode: string, cards: CardVariant[]): SetSearchGroup {
  // SetSearchGroup groups cards by base name within a set. The tests
  // here don't care about grouping shape — one group per basename is
  // fine — they exercise the filter logic, not the grouping.
  const byName = new Map<string, CardVariant[]>();
  for (const c of cards) {
    const base = c.name.replace(/\s*\([^)]*\)\s*$/, '');
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base)!.push(c);
  }
  return {
    setSlug: set,
    setCode,
    setName: set,
    groups: [...byName.entries()].map(([baseName, variants]) => ({ baseName, variants })),
  };
}

describe('applySelectionFilters', () => {
  it('passes input through untouched when no filters are set', () => {
    const input = [
      group('jump-to-lightspeed', 'JTL', [card('jump-to-lightspeed', 'A')]),
      group('legends-of-the-force', 'LOF', [card('legends-of-the-force', 'B')]),
    ];
    expect(applySelectionFilters(input, { selectedSets: [], selectedVariants: [] })).toEqual(input);
  });

  it('filters by exact set slug', () => {
    const input = [
      group('jump-to-lightspeed', 'JTL', [card('jump-to-lightspeed', 'A')]),
      group('legends-of-the-force', 'LOF', [card('legends-of-the-force', 'B')]),
    ];
    const out = applySelectionFilters(input, { selectedSets: ['jump-to-lightspeed'], selectedVariants: [] });
    expect(out).toHaveLength(1);
    expect(out[0].setSlug).toBe('jump-to-lightspeed');
  });

  it('filters by variant label', () => {
    const input = [
      group('jump-to-lightspeed', 'JTL', [
        card('jump-to-lightspeed', 'A'),
        card('jump-to-lightspeed', 'A (Hyperspace)'),
        card('jump-to-lightspeed', 'A (Showcase)'),
      ]),
    ];
    const out = applySelectionFilters(input, { selectedSets: [], selectedVariants: ['Hyperspace'] });
    expect(out).toHaveLength(1);
    // Only the Hyperspace variant survives inside the group
    expect(out[0].groups[0].variants).toHaveLength(1);
    expect(out[0].groups[0].variants[0].name).toBe('A (Hyperspace)');
  });

  it('drops groups whose variants are all filtered out', () => {
    const input = [
      group('jump-to-lightspeed', 'JTL', [
        card('jump-to-lightspeed', 'A (Standard)'),
        card('jump-to-lightspeed', 'B (Hyperspace)'),
      ]),
    ];
    const out = applySelectionFilters(input, { selectedSets: [], selectedVariants: ['Hyperspace'] });
    expect(out).toHaveLength(1);
    expect(out[0].groups).toHaveLength(1);
    expect(out[0].groups[0].baseName).toBe('B');
  });

  it('drops set-groups whose groups are all filtered out', () => {
    const input = [
      group('jump-to-lightspeed', 'JTL', [card('jump-to-lightspeed', 'A (Hyperspace)')]),
      group('legends-of-the-force', 'LOF', [card('legends-of-the-force', 'B (Standard)')]),
    ];
    const out = applySelectionFilters(input, { selectedSets: [], selectedVariants: ['Hyperspace'] });
    expect(out).toHaveLength(1);
    expect(out[0].setSlug).toBe('jump-to-lightspeed');
  });

  describe('MAIN_GROUP preset', () => {
    it('matches every main set but no promo set', () => {
      const input = [
        group('jump-to-lightspeed', 'JTL', [card('jump-to-lightspeed', 'A')]),    // main
        group('a-lawless-time', 'LAW', [card('a-lawless-time', 'B')]),            // main
        group('judge-promos', 'JP', [card('judge-promos', 'C')]),                 // promo
      ];
      const out = applySelectionFilters(input, { selectedSets: [MAIN_GROUP], selectedVariants: [] });
      expect(out.map(s => s.setSlug).sort()).toEqual(
        ['a-lawless-time', 'jump-to-lightspeed'],
      );
    });
  });

  describe('SPECIAL_GROUP preset', () => {
    it('matches every promo set but no main set', () => {
      const input = [
        group('jump-to-lightspeed', 'JTL', [card('jump-to-lightspeed', 'A')]),
        group('judge-promos', 'JP', [card('judge-promos', 'B')]),
      ];
      const out = applySelectionFilters(input, { selectedSets: [SPECIAL_GROUP], selectedVariants: [] });
      expect(out.map(s => s.setSlug)).toEqual(['judge-promos']);
    });
  });

  it('unions group preset with exact slugs (additive)', () => {
    // When both a preset and an exact slug are present, the slug is
    // matched if it satisfies EITHER — so MAIN_GROUP + judge-promos
    // lets every main set AND judge-promos through.
    const input = [
      group('jump-to-lightspeed', 'JTL', [card('jump-to-lightspeed', 'A')]),
      group('judge-promos', 'JP', [card('judge-promos', 'B')]),
      group('organized-play-promos', 'OPP', [card('organized-play-promos', 'C')]),
    ];
    const out = applySelectionFilters(input, { selectedSets: [MAIN_GROUP, 'judge-promos'], selectedVariants: [] });
    expect(out.map(s => s.setSlug).sort()).toEqual(
      ['judge-promos', 'jump-to-lightspeed'],
    );
  });

  it('combines variant + set filters (AND across dimensions)', () => {
    const input = [
      group('jump-to-lightspeed', 'JTL', [
        card('jump-to-lightspeed', 'A (Standard)'),
        card('jump-to-lightspeed', 'A (Hyperspace)'),
      ]),
      group('judge-promos', 'JP', [
        card('judge-promos', 'B (Hyperspace)'),
      ]),
    ];
    const out = applySelectionFilters(input, { selectedSets: [MAIN_GROUP], selectedVariants: ['Hyperspace'] });
    expect(out).toHaveLength(1);
    expect(out[0].setSlug).toBe('jump-to-lightspeed');
    expect(out[0].groups[0].variants).toHaveLength(1);
    expect(out[0].groups[0].variants[0].name).toBe('A (Hyperspace)');
  });

  describe('rarity filter', () => {
    it('passes through when selectedRarities is empty (default)', () => {
      const input = [
        group('jump-to-lightspeed', 'JTL', [
          card('jump-to-lightspeed', 'A', { rarity: 'Common' }),
          card('jump-to-lightspeed', 'B', { rarity: 'Legendary' }),
        ]),
      ];
      const out = applySelectionFilters(input, { selectedSets: [], selectedVariants: [], selectedRarities: [] });
      expect(out).toEqual(input);
    });

    it('narrows to cards whose rarity matches the selection', () => {
      const input = [
        group('jump-to-lightspeed', 'JTL', [
          card('jump-to-lightspeed', 'A', { rarity: 'Common' }),
          card('jump-to-lightspeed', 'B', { rarity: 'Rare' }),
          card('jump-to-lightspeed', 'C', { rarity: 'Legendary' }),
        ]),
      ];
      const out = applySelectionFilters(input, { selectedSets: [], selectedVariants: [], selectedRarities: ['Rare', 'Legendary'] });
      expect(out).toHaveLength(1);
      expect(out[0].groups.map(g => g.baseName).sort()).toEqual(['B', 'C']);
    });

    it('drops set-groups whose cards are all rarity-filtered out', () => {
      const input = [
        group('jump-to-lightspeed', 'JTL', [card('jump-to-lightspeed', 'A', { rarity: 'Common' })]),
        group('legends-of-the-force', 'LOF', [card('legends-of-the-force', 'B', { rarity: 'Rare' })]),
      ];
      const out = applySelectionFilters(input, { selectedSets: [], selectedVariants: [], selectedRarities: ['Rare'] });
      expect(out).toHaveLength(1);
      expect(out[0].setSlug).toBe('legends-of-the-force');
    });

    it('combines with variant filter (both must match)', () => {
      const input = [
        group('jump-to-lightspeed', 'JTL', [
          card('jump-to-lightspeed', 'A (Standard)', { rarity: 'Rare' }),
          card('jump-to-lightspeed', 'A (Hyperspace)', { rarity: 'Common' }),
        ]),
      ];
      const out = applySelectionFilters(input, {
        selectedSets: [],
        selectedVariants: ['Hyperspace'],
        selectedRarities: ['Rare'],
      });
      // Hyperspace + Rare: nothing matches both → group dropped.
      expect(out).toHaveLength(0);
    });
  });

  describe('sortBy="price-desc"', () => {
    it('flattens to one synthetic group sorted by max price desc', () => {
      const input = [
        group('jump-to-lightspeed', 'JTL', [
          card('jump-to-lightspeed', 'Cheap', { marketPrice: 0.5, lowPrice: 0.3 }),
          card('jump-to-lightspeed', 'Mid',   { marketPrice: 5,   lowPrice: 4 }),
        ]),
        group('legends-of-the-force', 'LOF', [
          card('legends-of-the-force', 'Spendy', { marketPrice: 100, lowPrice: 90 }),
        ]),
        group('a-lawless-time', 'LAW', [
          card('a-lawless-time', 'Very Spendy', { marketPrice: 250, lowPrice: 240 }),
        ]),
      ];
      const out = applySelectionFilters(input, {
        selectedSets: [],
        selectedVariants: [],
        sortBy: 'price-desc',
        priceMode: 'market',
      });
      // One synthetic group named for the new sort.
      expect(out).toHaveLength(1);
      expect(out[0].setName).toMatch(/Sorted by price/i);
      // Card families ordered by max-price-desc, no set boundaries.
      expect(out[0].groups.map(g => g.baseName)).toEqual(['Very Spendy', 'Spendy', 'Mid', 'Cheap']);
    });

    it('uses the active priceMode as the sort key', () => {
      const input = [
        group('jump-to-lightspeed', 'JTL', [
          // Card A: high market, low low — should rank high under
          // 'market' but low under 'low'.
          card('jump-to-lightspeed', 'A', { marketPrice: 100, lowPrice: 1 }),
          card('jump-to-lightspeed', 'B', { marketPrice: 5, lowPrice: 50 }),
        ]),
      ];

      const market = applySelectionFilters(input, {
        selectedSets: [], selectedVariants: [], sortBy: 'price-desc', priceMode: 'market',
      });
      expect(market[0].groups.map(g => g.baseName)).toEqual(['A', 'B']);

      const low = applySelectionFilters(input, {
        selectedSets: [], selectedVariants: [], sortBy: 'price-desc', priceMode: 'low',
      });
      expect(low[0].groups.map(g => g.baseName)).toEqual(['B', 'A']);
    });

    it('sinks unpriced groups to the bottom', () => {
      const input = [
        group('jump-to-lightspeed', 'JTL', [
          card('jump-to-lightspeed', 'Unpriced', { marketPrice: null, lowPrice: null }),
          card('jump-to-lightspeed', 'Real', { marketPrice: 5, lowPrice: 4 }),
        ]),
      ];
      const out = applySelectionFilters(input, {
        selectedSets: [], selectedVariants: [], sortBy: 'price-desc', priceMode: 'market',
      });
      expect(out[0].groups.map(g => g.baseName)).toEqual(['Real', 'Unpriced']);
    });

    it('returns empty when filters drop everything before the sort step', () => {
      const input = [
        group('jump-to-lightspeed', 'JTL', [card('jump-to-lightspeed', 'A', { rarity: 'Common' })]),
      ];
      const out = applySelectionFilters(input, {
        selectedSets: [], selectedVariants: [], selectedRarities: ['Legendary'], sortBy: 'price-desc',
      });
      expect(out).toEqual([]);
    });
  });
});
