import { useEffect, useState } from 'react';
import { apiPost } from '../services/apiClient';

/**
 * Per-row popular-wants signal for binder rows. The 2026-05-20 rewrite
 * switched this surface from a familyId-only count to a per-productId
 * restriction-aware count plus a list of surfaceable wanter
 * identities so the "N wants this" badge can be made tappable for
 * trade-discovery.
 *
 * Input is keyed by `productId` (each binder row has a unique one)
 * with the row's `familyId` + concrete `variant` attached so the
 * server can filter wants whose restriction would actually accept
 * the binder's specific print. A want restricted to `Hyperspace
 * Foil` no longer counts toward a Standard binder row.
 *
 * Response shape, per productId:
 *   - `count`: number of distinct OTHER users with a wants restriction
 *     that matches this row's variant. Includes hidden-profile users
 *     so the statistical signal is honest.
 *   - `users`: up to 10 PublicUser tuples (handle / username /
 *     avatarUrl) for surfacing in a popover. Users with
 *     profileVisibility='private' are filtered out of this list
 *     (they opt out of discovery) but their want still contributes
 *     to the count.
 */
export interface PopularWantsUser {
  handle: string;
  username: string;
  avatarUrl: string | null;
}

export interface PopularWantsEntry {
  count: number;
  users: PopularWantsUser[];
}

export interface PopularWantsInput {
  productId: string;
  familyId: string;
  variant: string;
}

export function usePopularWants(items: readonly PopularWantsInput[]): Record<string, PopularWantsEntry> {
  const [counts, setCounts] = useState<Record<string, PopularWantsEntry>>({});

  useEffect(() => {
    if (items.length === 0) {
      setCounts({});
      return;
    }

    // Sort by productId to stabilize the cache key — same set in any
    // order produces the same request body so repeated reorders don't
    // refetch.
    const normalized = [...items].sort((a, b) => a.productId.localeCompare(b.productId));
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await apiPost<{ counts?: Record<string, PopularWantsEntry> }>(
        '/api/popular-wants',
        { items: normalized },
      );
      if (cancelled) return;
      setCounts(result.ok ? (result.data.counts ?? {}) : {});
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The stringified shape pins the effect deps — same set in same
    // order means same fetch. Disabling exhaustive-deps because the
    // serialized form IS the dep, not the array reference identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map(i => `${i.productId}:${i.variant}`).join(',')]);

  return counts;
}

// --- Symmetric: wishlist direction ---------------------------------

/**
 * Per-row "popular haves" for wishlist rows. Mirror of
 * `usePopularWants` — same shape, opposite direction. Each input is
 * a wishlist row's identity + restriction; each entry is the set of
 * traders who have a print of that family with a variant satisfying
 * the restriction.
 *
 * Backed by the same `/api/popular-wants` function file (dispatched
 * to the `haves` branch via the vercel.json rewrite) so the deploy
 * stays under the Hobby function-count ceiling.
 */
export interface PopularHavesInput {
  rowId: string;
  familyId: string;
  restrictionMode: 'any' | 'restricted';
  restrictionVariants?: readonly string[];
}

export function usePopularHaves(items: readonly PopularHavesInput[]): Record<string, PopularWantsEntry> {
  const [counts, setCounts] = useState<Record<string, PopularWantsEntry>>({});

  useEffect(() => {
    if (items.length === 0) {
      setCounts({});
      return;
    }

    const normalized = [...items].sort((a, b) => a.rowId.localeCompare(b.rowId));
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await apiPost<{ counts?: Record<string, PopularWantsEntry> }>(
        '/api/popular-haves',
        { items: normalized },
      );
      if (cancelled) return;
      setCounts(result.ok ? (result.data.counts ?? {}) : {});
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map(i => {
    const key = i.restrictionMode === 'any'
      ? 'any'
      : `r:${[...(i.restrictionVariants ?? [])].sort().join('|')}`;
    return `${i.rowId}:${i.familyId}:${key}`;
  }).join(',')]);

  return counts;
}
