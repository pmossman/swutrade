import { useEffect, useState } from 'react';
import { apiGet } from '../services/apiClient';

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
  const [partners, setPartners] = useState<RecentPartner[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await apiGet<{ partners: RecentPartner[] }>(
        '/api/me/recent-partners',
      );
      if (cancelled) return;
      if (!result.ok) {
        setStatus('error');
        return;
      }
      setPartners(result.data.partners);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, []);

  return { partners, status };
}
