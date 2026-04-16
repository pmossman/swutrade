import { useEffect, useState } from 'react';

/**
 * Fetches per-familyId counts of public wants from other users for
 * the caller's current available-list familyIds. The resulting map
 * is `{}`-empty for families nobody else wants, so downstream
 * components can just read `counts[familyId] ?? 0`.
 *
 * Debounces re-requests while the input list changes — useful when
 * the user edits their available list rapidly via the drawer.
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
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch('/api/popular-wants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ familyIds: normalized }),
        signal: controller.signal,
      })
        .then(r => r.ok ? r.json() : { counts: {} })
        .then((data: { counts?: Record<string, number> }) => {
          setCounts(data.counts ?? {});
        })
        .catch(err => {
          // AbortError is expected on unmount/refetch; ignore.
          if ((err as Error).name !== 'AbortError') {
            setCounts({});
          }
        });
    }, 300);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [familyIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  return counts;
}
