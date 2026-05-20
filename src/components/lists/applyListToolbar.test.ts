import { describe, it, expect } from 'vitest';
import {
  applyListToolbar,
  activeFilterCount,
  DEFAULT_LIST_FILTERS,
  type ListFilters,
  type ListRowMeta,
} from './applyListToolbar';
import type { CardVariant } from '../../types';
import { CANONICAL_VARIANTS } from '../../variants';
import { MAIN_GROUP, SPECIAL_GROUP } from '../../applySelectionFilters';

function card(overrides: Partial<CardVariant> = {}): CardVariant {
  return {
    name: overrides.name ?? 'Luke Skywalker',
    variant: overrides.variant ?? 'Standard',
    printing: 'Standard',
    rarity: 'Legendary',
    number: '001',
    marketPrice: overrides.marketPrice ?? 5,
    lowPrice: overrides.lowPrice ?? 4,
    set: overrides.set ?? 'spark-of-rebellion',
    setName: 'Spark of Rebellion',
    productId: overrides.productId ?? '1',
    displayName: overrides.displayName ?? overrides.name ?? 'Luke Skywalker',
    ...overrides,
  };
}

type Row = ListRowMeta & { id: string };

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    card: overrides.card !== undefined ? overrides.card : card(),
    addedAt: overrides.addedAt ?? 1000,
    variantTags: overrides.variantTags ?? [...CANONICAL_VARIANTS],
    isPriority: overrides.isPriority,
    isMatch: overrides.isMatch,
  };
}

describe('applyListToolbar — no filters', () => {
  it('default sort: priority first, then set (newest first), then aspect, then card number', () => {
    // Set recency from src/types/index.ts SETS array: LAW > JTL >
    // LOF > SEC > TWI > SHD > SOR. Within each set, aspect order
    // is Heroism, Vigilance, Command, Cunning, Aggression, Villainy.
    const rows: Row[] = [
      row('sor-luke', {
        card: card({ set: 'spark-of-rebellion', aspects: ['Heroism'], number: '001' }),
      }),
      row('law-cad', {
        card: card({ set: 'a-lawless-time', aspects: ['Villainy'], number: '050' }),
      }),
      row('law-han', {
        card: card({ set: 'a-lawless-time', aspects: ['Heroism'], number: '002' }),
      }),
      row('priority-old', {
        card: card({ set: 'spark-of-rebellion', aspects: ['Vigilance'], number: '003' }),
        isPriority: true,
      }),
    ];
    const result = applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'default', 'market');
    // Priority row first (regardless of set); then LAW block
    // (Heroism #002 before Villainy #050); then SOR block.
    expect(result.map(r => r.id)).toEqual(['priority-old', 'law-han', 'law-cad', 'sor-luke']);
  });

  it('default sort: tie-breaks by addedAt when set + aspect + number all match', () => {
    const sameCard = { set: 'a-lawless-time', aspects: ['Heroism'], number: '042' };
    const rows: Row[] = [
      row('newer', { card: card(sameCard), addedAt: 300 }),
      row('older', { card: card(sameCard), addedAt: 100 }),
      row('mid', { card: card(sameCard), addedAt: 200 }),
    ];
    const result = applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'default', 'market');
    // Stable tie-break: older first (matches the historical
    // priority-first-then-oldest-first behavior on a single-set list).
    expect(result.map(r => r.id)).toEqual(['older', 'mid', 'newer']);
  });

  it('default sort: keeps variants of the same card adjacent (Lawbringer regression)', () => {
    // Standard Lawbringer is printed as "101/264"; Hyperspace
    // version of the same card is "365" (it lives in the
    // Hyperspace numbering block past the base set). Naïvely
    // sorting by parsed number puts 264 cards between them; the
    // family-primary-number tier collapses both to position 101 so
    // they sit adjacent. Variant rank then orders Standard before
    // Hyperspace within that family slot.
    //
    // Real-data invariant: `displayName` is the base name WITHOUT
    // the variant suffix — enrichment normalizes this so every
    // variant of one card shares the same displayName + the same
    // familyId. The mock has to mirror that or cardFamilyId
    // (which keys off displayName) returns different ids for
    // each variant and the family-grouping tier never fires.
    const lawSet = { set: 'a-lawless-time', aspects: ['Vigilance', 'Villainy'] };
    const lawbringerDisplay = 'Lawbringer - Shadow Over Lothal';
    const rows: Row[] = [
      row('law-std', {
        card: card({
          ...lawSet,
          name: 'Lawbringer - Shadow Over Lothal',
          displayName: lawbringerDisplay,
          variant: 'Standard',
          number: '101/264',
        }),
        variantTags: ['Standard'],
      }),
      row('law-hs', {
        card: card({
          ...lawSet,
          name: 'Lawbringer - Shadow Over Lothal (Hyperspace)',
          displayName: lawbringerDisplay,
          variant: 'Hyperspace',
          number: '365',
        }),
        variantTags: ['Hyperspace'],
      }),
      row('bodhi', {
        card: card({
          ...lawSet,
          name: 'Bodhi Rook - Creating a Diversion',
          displayName: 'Bodhi Rook - Creating a Diversion',
          variant: 'Standard',
          number: '105/264',
        }),
        variantTags: ['Standard'],
      }),
    ];
    const result = applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'default', 'market');
    expect(result.map(r => r.id)).toEqual(['law-std', 'law-hs', 'bodhi']);
  });

  it('default sort: rows with null card sink to the bottom', () => {
    const rows: Row[] = [
      row('null', { card: null }),
      row('law', {
        card: card({ set: 'a-lawless-time', aspects: ['Heroism'], number: '001' }),
      }),
    ];
    const result = applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'default', 'market');
    expect(result.map(r => r.id)).toEqual(['law', 'null']);
  });

  it('does not mutate the input array', () => {
    const rows: Row[] = [row('a', { addedAt: 200 }), row('b', { addedAt: 100 })];
    const snapshot = rows.map(r => r.id);
    applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'newest', 'market');
    expect(rows.map(r => r.id)).toEqual(snapshot);
  });
});

describe('applyListToolbar — query filter', () => {
  it('matches by case-insensitive displayName substring', () => {
    const rows: Row[] = [
      row('luke', { card: card({ displayName: 'Luke Skywalker' }) }),
      row('vader', { card: card({ displayName: 'Darth Vader' }) }),
      row('han', { card: card({ displayName: 'Han Solo' }) }),
    ];
    const filters: ListFilters = { ...DEFAULT_LIST_FILTERS, query: 'darth' };
    const result = applyListToolbar(rows, filters, 'default', 'market');
    expect(result.map(r => r.id)).toEqual(['vader']);
  });

  it('falls back to name when displayName is missing', () => {
    const rows: Row[] = [
      row('a', { card: { ...card(), displayName: undefined, name: 'Cad Bane' } }),
    ];
    const filters: ListFilters = { ...DEFAULT_LIST_FILTERS, query: 'cad' };
    expect(applyListToolbar(rows, filters, 'default', 'market')).toHaveLength(1);
  });

  it('drops rows with null card when query is non-empty', () => {
    const rows: Row[] = [row('null', { card: null })];
    const filters: ListFilters = { ...DEFAULT_LIST_FILTERS, query: 'luke' };
    expect(applyListToolbar(rows, filters, 'default', 'market')).toEqual([]);
  });

  it('keeps rows with null card when query is empty', () => {
    const rows: Row[] = [row('null', { card: null })];
    expect(applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'default', 'market')).toHaveLength(1);
  });
});

describe('applyListToolbar — set filter', () => {
  it('filters by exact set slug', () => {
    const rows: Row[] = [
      row('sor', { card: card({ set: 'spark-of-rebellion' }) }),
      row('shd', { card: card({ set: 'shadows-of-the-galaxy' }) }),
    ];
    const filters: ListFilters = { ...DEFAULT_LIST_FILTERS, selectedSets: ['spark-of-rebellion'] };
    expect(applyListToolbar(rows, filters, 'default', 'market').map(r => r.id)).toEqual(['sor']);
  });

  it('expands MAIN_GROUP pseudo-slug to every main-category set', () => {
    const rows: Row[] = [
      row('sor', { card: card({ set: 'spark-of-rebellion' }) }),
      row('shd', { card: card({ set: 'shadows-of-the-galaxy' }) }),
      row('twi', { card: card({ set: 'twilight-of-the-republic' }) }),
    ];
    const filters: ListFilters = { ...DEFAULT_LIST_FILTERS, selectedSets: [MAIN_GROUP] };
    // All three are main expansions per src/types/index.ts.
    expect(applyListToolbar(rows, filters, 'default', 'market')).toHaveLength(3);
  });

  it('SPECIAL_GROUP excludes main-set rows', () => {
    const rows: Row[] = [
      row('sor', { card: card({ set: 'spark-of-rebellion' }) }),
    ];
    const filters: ListFilters = { ...DEFAULT_LIST_FILTERS, selectedSets: [SPECIAL_GROUP] };
    expect(applyListToolbar(rows, filters, 'default', 'market')).toEqual([]);
  });
});

describe('applyListToolbar — variant filter', () => {
  it('passes rows whose variantTags intersect with selectedVariants', () => {
    const rows: Row[] = [
      row('std', { variantTags: ['Standard'] }),
      row('hsf', { variantTags: ['Hyperspace Foil'] }),
      row('any', { variantTags: [...CANONICAL_VARIANTS] }),
    ];
    const filters: ListFilters = {
      ...DEFAULT_LIST_FILTERS,
      selectedVariants: ['Hyperspace Foil'],
    };
    expect(applyListToolbar(rows, filters, 'default', 'market').map(r => r.id).sort())
      .toEqual(['any', 'hsf']);
  });

  it('a Wants row with restriction.any (tags = all canonicals) matches any variant filter', () => {
    const rows: Row[] = [
      row('any', { variantTags: [...CANONICAL_VARIANTS] }),
    ];
    const filters: ListFilters = {
      ...DEFAULT_LIST_FILTERS,
      selectedVariants: ['Showcase'],
    };
    expect(applyListToolbar(rows, filters, 'default', 'market')).toHaveLength(1);
  });
});

describe('applyListToolbar — priorityOnly / matchOnly', () => {
  it('priorityOnly drops non-priority rows', () => {
    const rows: Row[] = [
      row('p', { isPriority: true }),
      row('n', { isPriority: false }),
    ];
    const filters: ListFilters = { ...DEFAULT_LIST_FILTERS, priorityOnly: true };
    expect(applyListToolbar(rows, filters, 'default', 'market').map(r => r.id)).toEqual(['p']);
  });

  it('matchOnly drops non-match rows', () => {
    const rows: Row[] = [
      row('m', { isMatch: true }),
      row('n', { isMatch: false }),
    ];
    const filters: ListFilters = { ...DEFAULT_LIST_FILTERS, matchOnly: true };
    expect(applyListToolbar(rows, filters, 'default', 'market').map(r => r.id)).toEqual(['m']);
  });
});

describe('applyListToolbar — sort modes', () => {
  it('newest sorts by addedAt desc', () => {
    const rows: Row[] = [
      row('a', { addedAt: 100 }),
      row('b', { addedAt: 300 }),
      row('c', { addedAt: 200 }),
    ];
    expect(applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'newest', 'market').map(r => r.id))
      .toEqual(['b', 'c', 'a']);
  });

  it('oldest sorts by addedAt asc', () => {
    const rows: Row[] = [
      row('a', { addedAt: 100 }),
      row('b', { addedAt: 300 }),
      row('c', { addedAt: 200 }),
    ];
    expect(applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'oldest', 'market').map(r => r.id))
      .toEqual(['a', 'c', 'b']);
  });

  it('price-desc sorts highest first; null prices sink', () => {
    const rows: Row[] = [
      row('mid', { card: card({ marketPrice: 5 }) }),
      row('hi', { card: card({ marketPrice: 20 }) }),
      row('nil', { card: card({ marketPrice: null }) }),
      row('lo', { card: card({ marketPrice: 1 }) }),
    ];
    expect(applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'price-desc', 'market').map(r => r.id))
      .toEqual(['hi', 'mid', 'lo', 'nil']);
  });

  it('price-asc sorts lowest first; null prices STILL sink to bottom', () => {
    const rows: Row[] = [
      row('mid', { card: card({ marketPrice: 5 }) }),
      row('hi', { card: card({ marketPrice: 20 }) }),
      row('nil', { card: card({ marketPrice: null }) }),
      row('lo', { card: card({ marketPrice: 1 }) }),
    ];
    expect(applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'price-asc', 'market').map(r => r.id))
      .toEqual(['lo', 'mid', 'hi', 'nil']);
  });

  it('name-asc sorts alphabetically; null cards sink', () => {
    const rows: Row[] = [
      row('luke', { card: card({ displayName: 'Luke' }) }),
      row('cad', { card: card({ displayName: 'Cad Bane' }) }),
      row('null', { card: null }),
    ];
    expect(applyListToolbar(rows, DEFAULT_LIST_FILTERS, 'name-asc', 'market').map(r => r.id))
      .toEqual(['cad', 'luke', 'null']);
  });
});

describe('activeFilterCount', () => {
  it('counts each axis once', () => {
    expect(activeFilterCount(DEFAULT_LIST_FILTERS)).toBe(0);
    expect(activeFilterCount({
      ...DEFAULT_LIST_FILTERS,
      query: 'luke',
      selectedSets: ['spark-of-rebellion'],
      selectedVariants: ['Hyperspace'],
      priorityOnly: true,
      matchOnly: true,
    })).toBe(5);
  });

  it('whitespace-only query does not count', () => {
    expect(activeFilterCount({ ...DEFAULT_LIST_FILTERS, query: '   ' })).toBe(0);
  });
});
