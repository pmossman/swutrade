import { z } from 'zod';
import { CANONICAL_VARIANTS } from '../variants';

export const PercentageSchema = z.number().int().min(1).max(100);
export const PriceModeSchema = z.enum(['market', 'low']);
export const StringArraySchema = z.array(z.string());

export type PriceMode = z.infer<typeof PriceModeSchema>;

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
  // Positive-selection filters. Empty array = "allow all". Each surface
  // (trade search, wants/available picker) has its own persisted state
  // so a narrow picker filter doesn't also narrow the trade view.
  tradeSelVariants: 'swu.trade.selVariants',
  tradeSelSets: 'swu.trade.selSets',
  pickerSelVariants: 'swu.picker.selVariants',
  pickerSelSets: 'swu.picker.selSets',
  // v2: keyed by cardFamilyId (cross-printing) rather than swuapi's
  // baseCardId (per-printing). v1 data is not migrated — fresh start.
  wants: 'swu.wants.v2',
  available: 'swu.available.v1',
  // Per-device toggle between side-by-side and tabbed trade panels.
  // Beta feedback: always-on both-sides layout feels cramped; users
  // want a single-focus view. Default (absent) = split layout so
  // existing users see no change; setting flips them to tabs.
  tradeViewMode: 'swu.tradeView',
} as const;

export const DEFAULTS = {
  percentage: 80,
  priceMode: 'market',
  selVariants: [] as string[],
  selSets: [] as string[],
  wants: [] as WantsItem[],
  available: [] as AvailableItem[],
} as const satisfies {
  percentage: number;
  priceMode: PriceMode;
  selVariants: string[];
  selSets: string[];
  wants: WantsItem[];
  available: AvailableItem[];
};
