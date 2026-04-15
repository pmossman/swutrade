import { describe, expect, it } from 'vitest';
import type { CardVariant } from './types';
import type { SetSearchGroup } from './hooks/useCardSearch';
import {
  applySelectionFilters,
  MAIN_GROUP,
  SPECIAL_GROUP,
} from './applySelectionFilters';

function card(set: string, name: string): CardVariant {
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
    expect(applySelectionFilters(input, [], [])).toEqual(input);
  });

  it('filters by exact set slug', () => {
    const input = [
      group('jump-to-lightspeed', 'JTL', [card('jump-to-lightspeed', 'A')]),
      group('legends-of-the-force', 'LOF', [card('legends-of-the-force', 'B')]),
    ];
    const out = applySelectionFilters(input, ['jump-to-lightspeed'], []);
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
    const out = applySelectionFilters(input, [], ['Hyperspace']);
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
    const out = applySelectionFilters(input, [], ['Hyperspace']);
    expect(out).toHaveLength(1);
    expect(out[0].groups).toHaveLength(1);
    expect(out[0].groups[0].baseName).toBe('B');
  });

  it('drops set-groups whose groups are all filtered out', () => {
    const input = [
      group('jump-to-lightspeed', 'JTL', [card('jump-to-lightspeed', 'A (Hyperspace)')]),
      group('legends-of-the-force', 'LOF', [card('legends-of-the-force', 'B (Standard)')]),
    ];
    const out = applySelectionFilters(input, [], ['Hyperspace']);
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
      const out = applySelectionFilters(input, [MAIN_GROUP], []);
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
      const out = applySelectionFilters(input, [SPECIAL_GROUP], []);
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
    const out = applySelectionFilters(input, [MAIN_GROUP, 'judge-promos'], []);
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
    const out = applySelectionFilters(input, [MAIN_GROUP], ['Hyperspace']);
    expect(out).toHaveLength(1);
    expect(out[0].setSlug).toBe('jump-to-lightspeed');
    expect(out[0].groups[0].variants).toHaveLength(1);
    expect(out[0].groups[0].variants[0].name).toBe('A (Hyperspace)');
  });
});
