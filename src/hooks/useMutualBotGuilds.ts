import { useEffect, useState } from 'react';
import { apiGet } from '../services/apiClient';
import { createKeyedCache } from './sharedCache';

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

// Module-scoped keyed cache: keyed by counterpart handle so flipping
// between recipients in HandlePickerDialog doesn't re-fetch a pair
// the user just looked at. Audit 07-performance #5.
const cache = createKeyedCache<string, MutualBotGuildOption[]>();

/** Testing-only: reset the module-scoped cache between test cases. */
export function __resetMutualBotGuildsCache() {
  cache.clear();
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
  const [guilds, setGuilds] = useState<MutualBotGuildOption[]>(
    () => (targetHandle ? cache.get(targetHandle) ?? [] : []),
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(() => {
    if (!targetHandle) return 'ready';
    return cache.has(targetHandle) ? 'ready' : 'loading';
  });

  useEffect(() => {
    if (!targetHandle) {
      setGuilds([]);
      setStatus('ready');
      return;
    }

    // Seed from the keyed cache when re-mounting on a previously-seen
    // handle. Effect still fires below to refresh in the background.
    if (cache.has(targetHandle)) {
      setGuilds(cache.get(targetHandle)!);
      setStatus('ready');
    } else {
      setGuilds([]);
      setStatus('loading');
    }

    let cancelled = false;
    (async () => {
      const result = await apiGet<MutualBotGuildOption[]>(
        `/api/me/mutual-bot-guilds?with=${encodeURIComponent(targetHandle)}`,
      );
      if (cancelled) return;
      if (!result.ok) {
        if (!cache.has(targetHandle)) setStatus('error');
        return;
      }
      cache.set(targetHandle, result.data);
      setGuilds(result.data);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, [targetHandle]);

  return { guilds, status };
}
