import { useCallback } from 'react';
import { apiGet, apiPut } from '../services/apiClient';
import { useResource } from './useResource';

export type ProfileVisibility = 'public' | 'discord' | 'private';

/** Any value a pref can carry. Mirrors `PrefValue` on the server. */
export type PrefValue = boolean | string;

/** Free-form map keyed by registry `key`. Keeping this shape loose
 *  means adding a pref to `lib/prefsRegistry.ts` doesn't require an
 *  additional hand-maintained TS type here — the registry is the
 *  only source of truth for which keys exist. Callers that need
 *  type-narrowed access pull the key out of the registry def. */
export type PrefsMap = Record<string, PrefValue>;

export interface AccountSettingsApi {
  settings: PrefsMap | null;
  status: 'loading' | 'ready' | 'saving' | 'error';
  update: (patch: PrefsMap) => Promise<void>;
}

/**
 * Loads the signed-in user's account-level prefs from `/api/me/prefs`
 * and provides an optimistic `update(patch)` that PUTs the patch and
 * rolls back on failure. Used by SettingsView.
 *
 * Endpoint is registry-driven (see lib/prefsRegistry.ts). Known
 * self-scoped pref keys are returned from GET; unknown keys in a PUT
 * body 400. `/api/me/settings` still routes to the same handler as a
 * transitional alias.
 *
 * Mutation lifecycle (gen-counter race protection + optimistic apply
 * + rollback) lives in `useResource`; this hook is a thin domain
 * adapter over it. Audit 13-mutation-patterns #1 — without the gen
 * guard, two rapid PUTs race and the slow one's rollback overwrites
 * the fast one's optimistic.
 */
export function useAccountSettings(): AccountSettingsApi {
  const resource = useResource<PrefsMap>({
    fetcher: async () => {
      const result = await apiGet<PrefsMap>('/api/me/prefs');
      return result.ok ? result.data : null;
    },
  });

  const update = useCallback(async (patch: PrefsMap) => {
    await resource.runMutation({
      optimistic: current => ({ ...current, ...patch }),
      request: () => apiPut<Record<string, never>>('/api/me/prefs', patch),
      // No applyCanonical — server's 200 confirms the patch was
      // applied as-is; optimistic state is canonical.
      // No explicit rollback — fall through to useResource's default
      // (refetch from the fetcher) on failure.
    });
  }, [resource]);

  return {
    settings: resource.data,
    status: resource.status,
    update,
  };
}
