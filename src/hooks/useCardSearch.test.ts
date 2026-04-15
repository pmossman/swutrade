import { describe, expect, it } from 'vitest';
import type { CardVariant, CardType } from '../types';
import {
  parseQuery,
  browseAllGroups,
  localSearch,
} from './useCardSearch';

function card(set: string, name: string, opts: Partial<CardVariant> = {}): CardVariant {
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
    ...opts,
  };
}

describe('parseQuery', () => {
  it('treats every token as a name term when no aliases match', () => {
    expect(parseQuery('darth vader')).toEqual({
      nameTerms: ['darth', 'vader'],
      setSlug: null,
      variantFilter: null,
    });
  });

  it('extracts a set-code alias and removes it from name terms', () => {
    expect(parseQuery('jtl luke')).toEqual({
      nameTerms: ['luke'],
      setSlug: 'jump-to-lightspeed',
      variantFilter: null,
    });
  });

  it('extracts a variant alias and removes it from name terms', () => {
    expect(parseQuery('luke hyperspace')).toEqual({
      nameTerms: ['luke'],
      setSlug: null,
      variantFilter: 'Hyperspace',
    });
  });

  it('combines set + variant + name in any order', () => {
    expect(parseQuery('hs jtl luke')).toEqual({
      nameTerms: ['luke'],
      setSlug: 'jump-to-lightspeed',
      variantFilter: 'Hyperspace',
    });
  });

  it('only consumes the first matching set alias; later matches stay as name terms', () => {
    // "law" → a-lawless-time. A second set alias would just be a
    // name term, since the parser greedily binds the first.
    const result = parseQuery('law jtl');
    expect(result.setSlug).toBe('a-lawless-time');
    expect(result.nameTerms).toContain('jtl');
  });

  it('expands "hs" / "hsf" / "showcase" / "sc" to their canonical labels', () => {
    expect(parseQuery('hsf').variantFilter).toBe('Hyperspace Foil');
    expect(parseQuery('sc').variantFilter).toBe('Showcase');
  });
});

describe('browseAllGroups', () => {
  it('returns an empty array for an empty input', () => {
    expect(browseAllGroups([])).toEqual([]);
  });

  it('groups cards by set + base name', () => {
    const cards = [
      card('jump-to-lightspeed', 'Card A'),
      card('jump-to-lightspeed', 'Card A (Hyperspace)'),
      card('jump-to-lightspeed', 'Card B'),
    ];
    const result = browseAllGroups(cards);
    expect(result).toHaveLength(1);
    expect(result[0].setSlug).toBe('jump-to-lightspeed');
    expect(result[0].groups).toHaveLength(2);
    const cardA = result[0].groups.find(g => g.baseName === 'Card A')!;
    expect(cardA.variants).toHaveLength(2);
  });

  it('orders main sets newest-first then promo sets', () => {
    const cards = [
      card('jump-to-lightspeed', 'JTL Card'),
      card('a-lawless-time', 'LAW Card'),
      card('judge-promos', 'JP Card'),
    ];
    const result = browseAllGroups(cards);
    // BROWSE_ORDER reverses main sets (so LAW appears before JTL — LAW
    // is the newest main release in the SETS table), then promo sets.
    const slugs = result.map(s => s.setSlug);
    expect(slugs.indexOf('a-lawless-time')).toBeLessThan(slugs.indexOf('jump-to-lightspeed'));
    expect(slugs.indexOf('jump-to-lightspeed')).toBeLessThan(slugs.indexOf('judge-promos'));
  });

  it('sinks Leader and Base groups to the bottom of each set', () => {
    // Critical UX rule: tradable units/events/upgrades surface first in
    // the picker — leader / base art is large and shouldn't eat the
    // initial scroll real estate.
    const cards = [
      card('jump-to-lightspeed', 'Leader Card', { cardType: 'Leader', number: '1' }),
      card('jump-to-lightspeed', 'Unit Card', { cardType: 'Unit', number: '50' }),
    ];
    const result = browseAllGroups(cards);
    const baseNames = result[0].groups.map(g => g.baseName);
    expect(baseNames).toEqual(['Unit Card', 'Leader Card']);
  });

  it('within a non-leader bucket, sorts ascending by card number', () => {
    const cards = [
      card('jump-to-lightspeed', 'Card C', { cardType: 'Unit' as CardType, number: '15' }),
      card('jump-to-lightspeed', 'Card A', { cardType: 'Unit' as CardType, number: '5' }),
      card('jump-to-lightspeed', 'Card B', { cardType: 'Unit' as CardType, number: '10' }),
    ];
    const result = browseAllGroups(cards);
    const baseNames = result[0].groups.map(g => g.baseName);
    expect(baseNames).toEqual(['Card A', 'Card B', 'Card C']);
  });

  it('skips sets unknown to SETS instead of throwing', () => {
    const cards = [
      card('this-set-does-not-exist', 'Mystery'),
      card('jump-to-lightspeed', 'Real Card'),
    ];
    const result = browseAllGroups(cards);
    expect(result.map(s => s.setSlug)).toEqual(['jump-to-lightspeed']);
  });
});

describe('localSearch', () => {
  const cards = [
    card('jump-to-lightspeed', 'Luke Skywalker'),
    card('jump-to-lightspeed', 'Luke Skywalker (Hyperspace)'),
    card('jump-to-lightspeed', 'Darth Vader'),
    card('a-lawless-time', 'Luke Skywalker', { number: '5' }),
  ];

  it('matches by name across sets', () => {
    const result = localSearch(cards, 'luke', null);
    const allHits = result.flatMap(sg => sg.groups.flatMap(g => g.variants));
    expect(allHits).toHaveLength(3); // 2 from JTL, 1 from LAW
  });

  it('narrows by set alias parsed out of the query', () => {
    const result = localSearch(cards, 'jtl luke', null);
    expect(result).toHaveLength(1);
    expect(result[0].setSlug).toBe('jump-to-lightspeed');
  });

  it('Hyperspace alias also matches Hyperspace Foil (prefix match by design)', () => {
    const more = [
      ...cards,
      card('jump-to-lightspeed', 'Luke Skywalker (Hyperspace Foil)'),
    ];
    const result = localSearch(more, 'luke hs', null);
    const variantNames = result.flatMap(sg =>
      sg.groups.flatMap(g => g.variants.map(v => v.name)),
    );
    expect(variantNames.some(n => n.includes('(Hyperspace)'))).toBe(true);
    expect(variantNames.some(n => n.includes('(Hyperspace Foil)'))).toBe(true);
    expect(variantNames.some(n => n === 'Luke Skywalker')).toBe(false);
  });

  it('explicit setFilter argument takes precedence over query-parsed set', () => {
    const result = localSearch(cards, 'jtl luke', 'a-lawless-time');
    expect(result).toHaveLength(1);
    expect(result[0].setSlug).toBe('a-lawless-time');
  });
});
