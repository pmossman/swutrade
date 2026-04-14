import { describe, expect, it } from 'vitest';
import {
  WantsItemSchema,
  WantsListSchema,
  AvailableItemSchema,
  VariantRestrictionSchema,
} from './schemas';

describe('VariantRestrictionSchema', () => {
  it('accepts { mode: "any" }', () => {
    expect(VariantRestrictionSchema.safeParse({ mode: 'any' }).success).toBe(true);
  });

  it('accepts { mode: "restricted", variants: [...] } with at least one variant', () => {
    const result = VariantRestrictionSchema.safeParse({
      mode: 'restricted',
      variants: ['Standard', 'Hyperspace'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects restricted mode with an empty variants array', () => {
    const result = VariantRestrictionSchema.safeParse({
      mode: 'restricted',
      variants: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown variant labels', () => {
    const result = VariantRestrictionSchema.safeParse({
      mode: 'restricted',
      variants: ['Something Made Up'],
    });
    expect(result.success).toBe(false);
  });
});

describe('WantsItemSchema', () => {
  const base = {
    id: 'w_1',
    familyId: 'spark-of-rebellion::luke-skywalker-faithful-friend',
    qty: 1,
    restriction: { mode: 'any' as const },
    addedAt: Date.now(),
  };

  it('accepts a minimal wants item', () => {
    expect(WantsItemSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an item with priority + note + maxUnitPrice', () => {
    const result = WantsItemSchema.safeParse({
      ...base,
      isPriority: true,
      note: 'Missing from my deck',
      maxUnitPrice: 15.5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects qty > 99', () => {
    expect(WantsItemSchema.safeParse({ ...base, qty: 100 }).success).toBe(false);
  });

  it('rejects qty < 1', () => {
    expect(WantsItemSchema.safeParse({ ...base, qty: 0 }).success).toBe(false);
  });

  it('rejects zero or negative maxUnitPrice', () => {
    expect(WantsItemSchema.safeParse({ ...base, maxUnitPrice: 0 }).success).toBe(false);
    expect(WantsItemSchema.safeParse({ ...base, maxUnitPrice: -1 }).success).toBe(false);
  });

  it('rejects empty familyId', () => {
    expect(WantsItemSchema.safeParse({ ...base, familyId: '' }).success).toBe(false);
  });

  it('round-trips through WantsListSchema with mixed items', () => {
    const list = [
      base,
      {
        ...base,
        id: 'w_2',
        familyId: 'a-lawless-time::some-card',
        restriction: { mode: 'restricted' as const, variants: ['Hyperspace', 'Showcase'] as const },
        isPriority: true,
      },
    ];
    const parsed = WantsListSchema.safeParse(list);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.length).toBe(2);
  });
});

describe('AvailableItemSchema', () => {
  const base = {
    id: 'a_1',
    productId: '540213',
    qty: 2,
    addedAt: Date.now(),
  };

  it('accepts a minimal available item', () => {
    expect(AvailableItemSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an item with a note', () => {
    expect(AvailableItemSchema.safeParse({ ...base, note: 'Near mint, English' }).success).toBe(true);
  });

  it('rejects qty > 99', () => {
    expect(AvailableItemSchema.safeParse({ ...base, qty: 100 }).success).toBe(false);
  });

  it('rejects empty productId', () => {
    expect(AvailableItemSchema.safeParse({ ...base, productId: '' }).success).toBe(false);
  });
});
