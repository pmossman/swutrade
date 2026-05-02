import { useEffect, useState } from 'react';
import { apiGet } from '../services/apiClient';
import { createSingletonCache } from './sharedCache';

export interface RecentPartner {
  userId: string;
  handle: string;
  username: string;
  avatarUrl: string | null;
  lastInteractionAt: string | null;
}

export interface RecentPartnersApi {
  partners: RecentPartner[];
  status: 'loading' | 'ready' | 'error';
}

// Module-scoped cache: HandlePickerDialog re-mounts on every open and
// would otherwise re-fetch each time even though the partner list
// changes only on mutation. Audit 07-performance #5.
const cache = createSingletonCache<RecentPartner[]>();

/** Testing-only: reset the module-scoped cache between test cases. */
export function __resetRecentPartnersCache() {
  cache.clear();
}

/**
 * Pulls up to five distinct counterparties the viewer has recently
 * exchanged a proposal with, newest first. Used by HandlePickerDialog
 * to render a "Recent" chips row above the typed-handle input so
 * repeat trading partners are one tap away.
 *
 * Fires once per mount (the dialog is mounted fresh each open, so the
 * list stays reasonably current without any explicit refresh path).
 */
export function useRecentPartners(): RecentPartnersApi {
  const [partners, setPartners] = useState<RecentPartner[]>(
    () => cache.get() ?? [],
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    () => (cache.has() ? 'ready' : 'loading'),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await apiGet<{ partners: RecentPartner[] }>(
        '/api/me/recent-partners',
      );
      if (cancelled) return;
      if (!result.ok) {
        if (!cache.has()) setStatus('error');
        return;
      }
      cache.set(result.data.partners);
      setPartners(result.data.partners);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, []);

  return { partners, status };
}
