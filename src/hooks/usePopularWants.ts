import { useEffect, useState } from 'react';
import { apiPost } from '../services/apiClient';

/**
 * Fetches per-familyId counts of public wants from other users for
 * the caller's current available-list familyIds. The resulting map
 * is `{}`-empty for families nobody else wants, so downstream
 * components can just read `counts[familyId] ?? 0`.
 *
 * Debounces re-requests while the input list changes — useful when
 * the user edits their available list rapidly via the drawer. The
 * debounce + cancelled-flag protects against stale state writes from
 * an earlier in-flight request landing after a newer one.
 */
export function usePopularWants(familyIds: readonly string[]): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (familyIds.length === 0) {
      setCounts({});
      return;
    }

    // Sort to stabilize the cache key — same set in any order maps
    // to the same request body so repeated reorders don't refetch.
    const normalized = [...familyIds].sort();
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await apiPost<{ counts?: Record<string, number> }>(
        '/api/popular-wants',
        { familyIds: normalized },
      );
      if (cancelled) return;
      setCounts(result.ok ? (result.data.counts ?? {}) : {});
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [familyIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  return counts;
}
