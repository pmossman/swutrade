import { useCallback, useEffect, useState } from 'react';

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/me/prefs');
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: PrefsMap = await res.json();
        if (cancelled) return;
        setSettings(data);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const update = useCallback(async (patch: PrefsMap) => {
    setSettings(prev => (prev ? { ...prev, ...patch } : prev));
    setStatus('saving');
    try {
      const res = await fetch('/api/me/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus('ready');
    } catch {
      // Roll back on failure — re-fetch to resync with the server.
      try {
        const res = await fetch('/api/me/prefs');
        if (res.ok) {
          const data: PrefsMap = await res.json();
          setSettings(data);
        }
      } catch {
        // swallow — status stays 'error', user sees the banner
      }
      setStatus('error');
    }
  }, []);

  return { settings, status, update };
}
