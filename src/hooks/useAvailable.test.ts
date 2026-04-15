import { describe, expect, it } from 'vitest';
import { availableAddReducer } from './useAvailable';
import type { AvailableItem } from '../persistence';

function makeDeps(idSeed = 0, startTime = 1000) {
  let idSeq = idSeed;
  let t = startTime;
  return {
    newId: () => `id${++idSeq}`,
    now: () => ++t,
  };
}

function existing(overrides: Partial<AvailableItem>): AvailableItem {
  return {
    id: 'existing',
    productId: '540505',
    qty: 1,
    addedAt: 100,
    ...overrides,
  };
}

describe('availableAddReducer', () => {
  it('appends a brand-new item when list is empty', () => {
    const { items, created } = availableAddReducer(
      [],
      { productId: '540505', qty: 3 },
      makeDeps(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].productId).toBe('540505');
    expect(items[0].qty).toBe(3);
    expect(created).toEqual(items[0]);
  });

  it('bumps qty when the same productId is already saved', () => {
    const prev = [existing({ qty: 2 })];
    const { items } = availableAddReducer(
      prev,
      { productId: '540505', qty: 5 },
      makeDeps(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(7);
  });

  it('creates a new item for a different productId', () => {
    const prev = [existing({ qty: 1 })];
    const { items } = availableAddReducer(
      prev,
      { productId: '614285', qty: 2 },
      makeDeps(),
    );
    expect(items).toHaveLength(2);
    expect(items.map(i => i.productId)).toEqual(['540505', '614285']);
  });

  it('caps qty at 99 on fresh and bump paths', () => {
    const fresh = availableAddReducer([], { productId: 'x', qty: 200 }, makeDeps());
    expect(fresh.items[0].qty).toBe(99);

    const bumped = availableAddReducer(
      [existing({ qty: 97 })],
      { productId: '540505', qty: 10 },
      makeDeps(),
    );
    expect(bumped.items[0].qty).toBe(99);
  });

  it('floors qty at 1 when input is 0 or missing', () => {
    const zero = availableAddReducer([], { productId: 'x', qty: 0 }, makeDeps());
    expect(zero.items[0].qty).toBe(1);

    const absent = availableAddReducer([], { productId: 'y' }, makeDeps());
    expect(absent.items[0].qty).toBe(1);
  });

  it('patches note on bump only when provided', () => {
    const prev = [existing({ qty: 1, note: 'original' })];
    const { items } = availableAddReducer(
      prev,
      { productId: '540505', qty: 1 },
      makeDeps(),
    );
    expect(items[0].note).toBe('original');

    const overridden = availableAddReducer(
      prev,
      { productId: '540505', note: 'new note' },
      makeDeps(),
    );
    expect(overridden.items[0].note).toBe('new note');
  });

  it('injects id + addedAt via deps on fresh items', () => {
    const deps = makeDeps(42, 9000);
    const { items } = availableAddReducer([], { productId: 'z' }, deps);
    expect(items[0].id).toBe('id43');
    expect(items[0].addedAt).toBe(9001);
  });
});
