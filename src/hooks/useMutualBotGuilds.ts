import { useEffect, useState } from 'react';
import { apiGet } from '../services/apiClient';

export interface MutualBotGuildOption {
  guildId: string;
  guildName: string;
  guildIcon: string | null;
  isDefault: boolean;
}

export interface MutualBotGuildsApi {
  guilds: MutualBotGuildOption[];
  status: 'loading' | 'ready' | 'error';
}

/**
 * Fetches the (viewer, target) pair's intersection of bot-installed
 * guilds. Drives the ProposeBar guild picker:
 *   - 0 results  → no picker (DM-only delivery, the existing path)
 *   - 1 result   → quiet "Trading in {Name}" label, no choice
 *   - 2+ results → inline dropdown defaulting to the server-chosen
 *                  guild (the entry with isDefault=true)
 *
 * Refetches whenever `targetHandle` changes (proposer might switch
 * recipients via HandlePickerDialog mid-compose). An empty handle
 * short-circuits to a `ready` state with no guilds — useful when the
 * caller hasn't picked a recipient yet.
 */
export function useMutualBotGuilds(targetHandle: string | null): MutualBotGuildsApi {
  const [guilds, setGuilds] = useState<MutualBotGuildOption[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!targetHandle) {
      setGuilds([]);
      setStatus('ready');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    (async () => {
      const result = await apiGet<MutualBotGuildOption[]>(
        `/api/me/mutual-bot-guilds?with=${encodeURIComponent(targetHandle)}`,
      );
      if (cancelled) return;
      if (!result.ok) {
        setStatus('error');
        return;
      }
      setGuilds(result.data);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, [targetHandle]);

  return { guilds, status };
}
