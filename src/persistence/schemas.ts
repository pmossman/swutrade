import { z } from 'zod';

export const PercentageSchema = z.number().int().min(1).max(100);
export const PriceModeSchema = z.enum(['market', 'low']);
export const StringArraySchema = z.array(z.string());
export const SearchScopeSchema = z.enum(['all', 'main', 'promo']);

export type PriceMode = z.infer<typeof PriceModeSchema>;
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const PERSIST_KEYS = {
  percentage: 'swu.pct',
  priceMode: 'swu.pm',
  hideVariants: 'swu.hideVariants',
  hideSets: 'swu.hideSets',
  searchScope: 'swu.searchScope',
} as const;

export const DEFAULTS = {
  percentage: 80,
  priceMode: 'market',
  hideVariants: [] as string[],
  hideSets: [] as string[],
  searchScope: 'all',
} as const satisfies {
  percentage: number;
  priceMode: PriceMode;
  hideVariants: string[];
  hideSets: string[];
  searchScope: SearchScope;
};
