import { describe, expect, it } from 'vitest';
import { wantsAddReducer, restrictionKey, normalizeRestriction } from './useWants';
import type { WantsItem } from '../persistence';
import { CANONICAL_VARIANTS } from '../variants';

function makeDeps(idSeed = 0, startTime = 1000) {
  let idSeq = idSeed;
  let t = startTime;
  return {
    newId: () => `id${++idSeq}`,
    now: () => ++t,
  };
}

function existingWant(overrides: Partial<WantsItem>): WantsItem {
  return {
    id: 'existing',
    familyId: 'jtl::luke',
    qty: 1,
    restriction: { mode: 'any' },
    addedAt: 100,
    ...overrides,
  };
}

describe('restrictionKey', () => {
  it('returns "any" for mode: any', () => {
    expect(restrictionKey({ mode: 'any' })).toBe('any');
  });

  it('sorts variants so equal sets produce equal keys', () => {
    expect(restrictionKey({ mode: 'restricted', variants: ['Hyperspace', 'Showcase'] }))
      .toBe(restrictionKey({ mode: 'restricted', variants: ['Showcase', 'Hyperspace'] }));
  });

  it('distinguishes different restriction sets', () => {
    expect(restrictionKey({ mode: 'restricted', variants: ['Hyperspace'] }))
      .not.toBe(restrictionKey({ mode: 'restricted', variants: ['Hyperspace Foil'] }));
  });
});

describe('normalizeRestriction', () => {
  it('passes through mode: any unchanged', () => {
    const r = { mode: 'any' as const };
    expect(normalizeRestriction(r)).toBe(r);
  });

  it('collapses all 10 current canonical variants to any', () => {
    const r = { mode: 'restricted' as const, variants: [...CANONICAL_VARIANTS] };
    expect(normalizeRestriction(r)).toEqual({ mode: 'any' });
  });

  it('collapses the original 8 canonical variants to any', () => {
    const r = {
      mode: 'restricted' as const,
      variants: CANONICAL_VARIANTS.slice(0, 8) as unknown as typeof CANONICAL_VARIANTS[number][],
    };
    expect(normalizeRestriction(r)).toEqual({ mode: 'any' });
  });

  it('preserves a genuine partial restriction', () => {
    const r = { mode: 'restricted' as const, variants: ['Hyperspace' as const, 'Showcase' as const] };
    expect(normalizeRestriction(r)).toBe(r);
  });

  it('preserves a single-variant restriction', () => {
    const r = { mode: 'restricted' as const, variants: ['Foil' as const] };
    expect(normalizeRestriction(r)).toBe(r);
  });
});

describe('wantsAddReducer', () => {
  it('appends a brand-new item when list is empty', () => {
    const { items, created } = wantsAddReducer(
      [],
      { familyId: 'jtl::luke', qty: 2 },
      makeDeps(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ familyId: 'jtl::luke', qty: 2 });
    expect(created).toEqual(items[0]);
  });

  it('bumps qty when (familyId + restriction) matches an existing any-want', () => {
    const prev = [existingWant({ qty: 2, restriction: { mode: 'any' } })];
    const { items, created } = wantsAddReducer(
      prev,
      { familyId: 'jtl::luke', qty: 3 },
      makeDeps(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(5);
    expect(created.id).toBe('existing');
  });

  it('creates a new item when restriction differs from an existing entry', () => {
    // CONTINUATION's worked example: Hyperspace-only want and Any-variant
    // want for the same card family must NOT collapse into one row.
    const prev = [existingWant({
      qty: 1,
      restriction: { mode: 'restricted', variants: ['Hyperspace'] },
    })];
    const { items } = wantsAddReducer(
      prev,
      { familyId: 'jtl::luke', qty: 1, restriction: { mode: 'any' } },
      makeDeps(),
    );
    expect(items).toHaveLength(2);
    expect(items[0].restriction.mode).toBe('restricted');
    expect(items[1].restriction.mode).toBe('any');
  });

  it('treats restrictions with variants in different orders as the same key', () => {
    const prev = [existingWant({
      qty: 1,
      restriction: { mode: 'restricted', variants: ['Hyperspace', 'Showcase'] },
    })];
    const { items } = wantsAddReducer(
      prev,
      {
        familyId: 'jtl::luke',
        qty: 1,
        restriction: { mode: 'restricted', variants: ['Showcase', 'Hyperspace'] },
      },
      makeDeps(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(2);
  });

  it('caps qty at 99 on both fresh and bump paths', () => {
    const fresh = wantsAddReducer([], { familyId: 'x', qty: 500 }, makeDeps());
    expect(fresh.items[0].qty).toBe(99);

    const bumped = wantsAddReducer(
      [existingWant({ qty: 95 })],
      { familyId: 'jtl::luke', qty: 10 },
      makeDeps(),
    );
    expect(bumped.items[0].qty).toBe(99);
  });

  it('floors qty at 1 when input is 0 or missing', () => {
    const zero = wantsAddReducer([], { familyId: 'x', qty: 0 }, makeDeps());
    expect(zero.items[0].qty).toBe(1);

    const absent = wantsAddReducer([], { familyId: 'y' }, makeDeps());
    expect(absent.items[0].qty).toBe(1);
  });

  it('patches isPriority / maxUnitPrice / note on bump only when provided', () => {
    const prev = [existingWant({ qty: 1, isPriority: true, note: 'old note' })];
    const { items } = wantsAddReducer(
      prev,
      { familyId: 'jtl::luke', qty: 1, maxUnitPrice: 5 },
      makeDeps(),
    );
    expect(items[0].qty).toBe(2);
    expect(items[0].isPriority).toBe(true);          // preserved
    expect(items[0].note).toBe('old note');          // preserved
    expect(items[0].maxUnitPrice).toBe(5);           // added
  });

  it('overrides isPriority on bump when explicitly passed', () => {
    const prev = [existingWant({ isPriority: true })];
    const { items } = wantsAddReducer(
      prev,
      { familyId: 'jtl::luke', isPriority: false },
      makeDeps(),
    );
    expect(items[0].isPriority).toBe(false);
  });

  it('injects id + addedAt via deps on fresh items', () => {
    const deps = makeDeps(10, 5000);
    const { items } = wantsAddReducer([], { familyId: 'a' }, deps);
    expect(items[0].id).toBe('id11');
    expect(items[0].addedAt).toBe(5001);
  });
});
