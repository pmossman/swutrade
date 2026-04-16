import { useCallback, useEffect, useState } from 'react';

export type ProfileVisibility = 'public' | 'discord' | 'private';

export interface AccountSettings {
  profileVisibility: ProfileVisibility;
  dmTradeProposals: boolean;
  dmMatchAlerts: boolean;
  dmMeetupReminders: boolean;
}

export interface AccountSettingsApi {
  settings: AccountSettings | null;
  status: 'loading' | 'ready' | 'saving' | 'error';
  update: (patch: Partial<AccountSettings>) => Promise<void>;
}

const DEFAULTS: AccountSettings = {
  profileVisibility: 'public',
  dmTradeProposals: true,
  dmMatchAlerts: false,
  dmMeetupReminders: false,
};

/**
 * Loads the signed-in user's account-level settings from
 * `/api/me/settings` and provides an optimistic `update(patch)` that
 * PUTs the patch and rolls back on failure. Used by SettingsView.
 */
export function useAccountSettings(): AccountSettingsApi {
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/me/settings');
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: AccountSettings = await res.json();
        if (cancelled) return;
        setSettings({ ...DEFAULTS, ...data });
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const update = useCallback(async (patch: Partial<AccountSettings>) => {
    setSettings(prev => (prev ? { ...prev, ...patch } : prev));
    setStatus('saving');
    try {
      const res = await fetch('/api/me/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus('ready');
    } catch {
      // Roll back on failure — re-fetch to resync with the server.
      try {
        const res = await fetch('/api/me/settings');
        if (res.ok) {
          const data: AccountSettings = await res.json();
          setSettings({ ...DEFAULTS, ...data });
        }
      } catch {
        // swallow — status stays 'error', user sees the banner
      }
      setStatus('error');
    }
  }, []);

  return { settings, status, update };
}
