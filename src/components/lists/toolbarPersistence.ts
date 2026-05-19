import type { ListFilters, ListSortMode } from './applyListToolbar';
import { DEFAULT_LIST_FILTERS, LIST_SORT_MODES } from './applyListToolbar';

/**
 * localStorage shape for the list toolbar. Keyed per surface
 * (wishlist / binder / profile:<handle>) so a power user who
 * narrows their wishlist to one set doesn't accidentally also
 * narrow their binder. `query` is intentionally not persisted —
 * search is a one-shot query, not a saved view, and reviving it
 * across navigations would surprise the user.
 */
export interface PersistedToolbarState {
  filters: Omit<ListFilters, 'query'>;
  sort: ListSortMode;
}

const STORAGE_PREFIX = 'swu.listToolbar.';

function storageKey(surfaceKey: string): string {
  return `${STORAGE_PREFIX}${surfaceKey}`;
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

function asStringArray(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  return x.every(isString) ? (x as string[]) : null;
}

function asSort(x: unknown): ListSortMode | null {
  if (!isString(x)) return null;
  return (LIST_SORT_MODES as readonly string[]).includes(x) ? (x as ListSortMode) : null;
}

/**
 * Read + validate the persisted toolbar state for a surface. Falls
 * back to defaults on missing / malformed entries (never throws).
 */
export function loadToolbarState(
  surfaceKey: string,
  defaultSort: ListSortMode,
): { filters: ListFilters; sort: ListSortMode } {
  if (typeof window === 'undefined') {
    return { filters: { ...DEFAULT_LIST_FILTERS }, sort: defaultSort };
  }
  const parsed = safeParse(window.localStorage.getItem(storageKey(surfaceKey)));
  if (!parsed || typeof parsed !== 'object') {
    return { filters: { ...DEFAULT_LIST_FILTERS }, sort: defaultSort };
  }
  const candidate = parsed as Partial<PersistedToolbarState> & { filters?: unknown };
  const filtersRaw = (candidate.filters ?? {}) as Record<string, unknown>;
  const selectedSets = asStringArray(filtersRaw.selectedSets) ?? [];
  const selectedVariants = asStringArray(filtersRaw.selectedVariants) ?? [];
  const filters: ListFilters = {
    ...DEFAULT_LIST_FILTERS,
    selectedSets,
    selectedVariants,
    priorityOnly: filtersRaw.priorityOnly === true,
    matchOnly: filtersRaw.matchOnly === true,
  };
  const sort = asSort(candidate.sort) ?? defaultSort;
  return { filters, sort };
}

/** Write the persistable subset (drops `query`). No-op when not in a
 *  browser. Swallows quota errors so a full localStorage doesn't
 *  break the toolbar. */
export function saveToolbarState(
  surfaceKey: string,
  filters: ListFilters,
  sort: ListSortMode,
): void {
  if (typeof window === 'undefined') return;
  // Strip `query` before persisting — see comment on
  // `PersistedToolbarState`.
  const { query: _query, ...rest } = filters;
  const payload: PersistedToolbarState = { filters: rest, sort };
  try {
    window.localStorage.setItem(storageKey(surfaceKey), JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage disabled — silently drop. The user
    // still gets the toolbar working within the session.
  }
}
