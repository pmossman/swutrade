import { z } from 'zod';
import { CANONICAL_VARIANTS } from '../variants';

export const PercentageSchema = z.number().int().min(1).max(100);
export const PriceModeSchema = z.enum(['market', 'low']);
export const StringArraySchema = z.array(z.string());
export const SearchScopeSchema = z.enum(['all', 'main', 'promo']);

export type PriceMode = z.infer<typeof PriceModeSchema>;
export type SearchScope = z.infer<typeof SearchScopeSchema>;

// --- List feature schemas ---------------------------------------------------
// Bumped to v1 suffix so a future breaking change can version up without
// nuking existing users' lists.

export const CanonicalVariantSchema = z.enum(CANONICAL_VARIANTS);

export const VariantRestrictionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('any') }),
  z.object({
    mode: z.literal('restricted'),
    variants: z.array(CanonicalVariantSchema).min(1),
  }),
]);

export const WantsItemSchema = z.object({
  id: z.string().min(1),
  /**
   * Cross-printing family identifier (see cardFamilyId in variants.ts).
   * Treats Standard, Hyperspace, Showcase, etc. of the same card as one
   * entity, so "any variant" matches every printing.
   */
  familyId: z.string().min(1),
  qty: z.number().int().min(1).max(99),
  restriction: VariantRestrictionSchema,
  maxUnitPrice: z.number().positive().optional(),
  note: z.string().max(500).optional(),
  isPriority: z.boolean().optional(),
  addedAt: z.number().int(),
});

export const WantsListSchema = z.array(WantsItemSchema);

export const AvailableItemSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  qty: z.number().int().min(1).max(99),
  note: z.string().max(500).optional(),
  addedAt: z.number().int(),
});

export const AvailableListSchema = z.array(AvailableItemSchema);

export type VariantRestriction = z.infer<typeof VariantRestrictionSchema>;
export type WantsItem = z.infer<typeof WantsItemSchema>;
export type AvailableItem = z.infer<typeof AvailableItemSchema>;

export const PERSIST_KEYS = {
  percentage: 'swu.pct',
  priceMode: 'swu.pm',
  hideVariants: 'swu.hideVariants',
  hideSets: 'swu.hideSets',
  searchScope: 'swu.searchScope',
  // v2: keyed by cardFamilyId (cross-printing) rather than swuapi's
  // baseCardId (per-printing). v1 data is not migrated — fresh start.
  wants: 'swu.wants.v2',
  available: 'swu.available.v1',
} as const;

export const DEFAULTS = {
  percentage: 80,
  priceMode: 'market',
  hideVariants: [] as string[],
  hideSets: [] as string[],
  searchScope: 'all',
  wants: [] as WantsItem[],
  available: [] as AvailableItem[],
} as const satisfies {
  percentage: number;
  priceMode: PriceMode;
  hideVariants: string[];
  hideSets: string[];
  searchScope: SearchScope;
  wants: WantsItem[];
  available: AvailableItem[];
};
