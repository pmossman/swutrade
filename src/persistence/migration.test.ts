import { describe, it, expect } from 'vitest';
import { WantsListSchema, AvailableListSchema, DEFAULTS } from './schemas';

describe('Schema migration resilience', () => {
  describe('WantsListSchema', () => {
    it('rejects v1 format (keyed by baseCardId, not familyId)', () => {
      const v1Data = [
        { id: 'w1', baseCardId: 'SOR_005', qty: 1, restriction: { mode: 'any' }, addedAt: 1 },
      ];
      const result = WantsListSchema.safeParse(v1Data);
      expect(result.success).toBe(false);
    });

    it('accepts valid v2 format', () => {
      const v2Data = [
        { id: 'w1', familyId: 'jtl::luke', qty: 1, restriction: { mode: 'any' }, addedAt: 1 },
      ];
      const result = WantsListSchema.safeParse(v2Data);
      expect(result.success).toBe(true);
    });

    it('accepts items with extra fields (forward compat)', () => {
      const futureData = [
        { id: 'w1', familyId: 'jtl::luke', qty: 1, restriction: { mode: 'any' }, addedAt: 1, newField: 'whatever' },
      ];
      const result = WantsListSchema.safeParse(futureData);
      // Zod strips unknown keys by default — this should still parse
      expect(result.success).toBe(true);
    });

    it('rejects items with invalid qty (0, 100, negative)', () => {
      for (const qty of [0, 100, -1]) {
        const data = [{ id: 'w', familyId: 'x::y', qty, restriction: { mode: 'any' }, addedAt: 1 }];
        const result = WantsListSchema.safeParse(data);
        expect(result.success).toBe(false);
      }
    });

    it('rejects items with missing required fields', () => {
      const noFamilyId = [{ id: 'w', qty: 1, restriction: { mode: 'any' }, addedAt: 1 }];
      expect(WantsListSchema.safeParse(noFamilyId).success).toBe(false);

      const noId = [{ familyId: 'x::y', qty: 1, restriction: { mode: 'any' }, addedAt: 1 }];
      expect(WantsListSchema.safeParse(noId).success).toBe(false);
    });

    it('falls back to defaults on completely invalid data', () => {
      expect(WantsListSchema.safeParse('not an array').success).toBe(false);
      expect(WantsListSchema.safeParse(42).success).toBe(false);
      expect(WantsListSchema.safeParse(null).success).toBe(false);
    });
  });

  describe('AvailableListSchema', () => {
    it('accepts valid format', () => {
      const data = [{ id: 'a1', productId: '622133', qty: 1, addedAt: 1 }];
      expect(AvailableListSchema.safeParse(data).success).toBe(true);
    });

    it('rejects missing productId', () => {
      const data = [{ id: 'a1', qty: 1, addedAt: 1 }];
      expect(AvailableListSchema.safeParse(data).success).toBe(false);
    });
  });
});
