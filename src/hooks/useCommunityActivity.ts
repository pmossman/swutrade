import { useEffect, useState } from 'react';
import { apiGet } from '../services/apiClient';

export type CommunityEventType = 'trade_accepted' | 'member_joined';

export interface CommunityEventActor {
  id: string;
  handle: string;
  username: string;
  avatarUrl: string | null;
}

export interface CommunityEvent {
  id: string;
  type: CommunityEventType;
  actor: CommunityEventActor | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface CommunityActivityApi {
  events: CommunityEvent[];
  status: 'idle' | 'loading' | 'ready' | 'error';
}

/**
 * Fetches the per-guild activity feed. Scoped by `guildId` — changing
 * it re-fetches. Passing a nullish value leaves the hook idle (used
 * on the guild-selector view where no guild is active yet).
 */
export function useCommunityActivity(guildId: string | null): CommunityActivityApi {
  const [events, setEvents] = useState<CommunityEvent[]>([]);
  const [status, setStatus] = useState<CommunityActivityApi['status']>('idle');

  useEffect(() => {
    if (!guildId) {
      setEvents([]);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    (async () => {
      const result = await apiGet<{ events: CommunityEvent[] }>(
        `/api/me/community-activity?guildId=${encodeURIComponent(guildId)}&limit=20`,
      );
      if (cancelled) return;
      if (!result.ok) {
        setStatus('error');
        return;
      }
      setEvents(result.data.events);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, [guildId]);

  return { events, status };
}
