import { useQuery } from '@tanstack/react-query';
import { fetchProductIndex, fetchFamilyIndex } from '../lib/cards';
import type { ProductIndex, FamilyIndex } from '../lib/cards';

/*
 * Loads the two lookup indexes the app reads from everywhere:
 *   - product-index.json — productId → { name, setName, prices }
 *   - family-index.json — familyId → [variants with productId + prices]
 *
 * These are static assets served from /data/*. Cache forever in
 * React Query; the underlying cron bumps the URL indirectly via a
 * fresh deploy.
 */

const STATIC_JSON = {
  staleTime: Infinity,
  gcTime: Infinity,
  retry: 1,
} as const;

export function useProductIndex() {
  return useQuery<ProductIndex>({
    queryKey: ['cards', 'product-index'],
    queryFn: fetchProductIndex,
    ...STATIC_JSON,
  });
}

export function useFamilyIndex() {
  return useQuery<FamilyIndex>({
    queryKey: ['cards', 'family-index'],
    queryFn: fetchFamilyIndex,
    ...STATIC_JSON,
  });
}
