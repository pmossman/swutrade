import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPut } from '../services/apiClient';

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
 * Loads the signed-in user's account-level prefs from
 * `/api/me/prefs` and provides an optimistic `update(patch)` that
 * PUTs the patch and rolls back on failure. Used by SettingsView.
 *
 * Endpoint is registry-driven (see lib/prefsRegistry.ts). Known
 * self-scoped pref keys are returned from GET; unknown keys in a
 * PUT body 400. `/api/me/settings` still routes to the same handler
 * as a transitional alias — will be removed once deployed clients
 * have rolled over.
 */
export function useAccountSettings(): AccountSettingsApi {
  const [settings, setSettings] = useState<PrefsMap | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');

  // Per-call generation counter — same shape as
  // useGuildMemberships.updateGuild (audit 13-mutation-patterns #1).
  // Without this, two `update()` calls in quick succession race:
  // PUT1's failure rollback re-fetches, the in-flight PUT2 lands
  // optimistic state on top, then PUT2's response or the rollback
  // re-fetch overwrites.
  const updateGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await apiGet<PrefsMap>('/api/me/prefs');
      if (cancelled) return;
      if (!result.ok) {
        setStatus('error');
        return;
      }
      setSettings(result.data);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, []);

  const update = useCallback(async (patch: PrefsMap) => {
    const gen = ++updateGenerationRef.current;
    setSettings(prev => (prev ? { ...prev, ...patch } : prev));
    setStatus('saving');
    const result = await apiPut('/api/me/prefs', patch);

    // Stale-response guard: a newer update started after ours. Drop
    // our completion path so we don't overwrite the newer optimistic
    // state with a rollback or a now-stale ready/error status.
    if (gen !== updateGenerationRef.current) {
      return;
    }

    if (result.ok) {
      setStatus('ready');
      return;
    }
    // Roll back on failure — re-fetch to resync with the server.
    const refreshed = await apiGet<PrefsMap>('/api/me/prefs');
    if (gen !== updateGenerationRef.current) return; // newer call landed mid-rollback
    if (refreshed.ok) setSettings(refreshed.data);
    setStatus('error');
  }, []);

  return { settings, status, update };
}
