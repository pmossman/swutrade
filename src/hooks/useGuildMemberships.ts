import { useCallback, useEffect, useState } from 'react';

export interface GuildMembershipSummary {
  guildId: string;
  guildName: string;
  guildIcon: string | null;
  canManage: boolean;
  enrolled: boolean;
  includeInRollups: boolean;
  appearInQueries: boolean;
}

export type GuildPatch = Partial<Pick<
  GuildMembershipSummary,
  'enrolled' | 'includeInRollups' | 'appearInQueries'
>>;

export interface GuildMembershipsApi {
  /** Guilds where SWUTrade's bot is installed — user can enroll. */
  enrollable: GuildMembershipSummary[];
  /** Guilds where the bot isn't installed — informational only. */
  other: GuildMembershipSummary[];
  status: 'loading' | 'ready' | 'saving' | 'error';
  /** PUT a patch for a specific guild, optimistically update locally. */
  updateGuild: (guildId: string, patch: GuildPatch) => Promise<void>;
}

export function useGuildMemberships(): GuildMembershipsApi {
  const [enrollable, setEnrollable] = useState<GuildMembershipSummary[]>([]);
  const [other, setOther] = useState<GuildMembershipSummary[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/me/guilds');
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data: { enrollable: GuildMembershipSummary[]; other: GuildMembershipSummary[] } = await res.json();
      setEnrollable(data.enrollable);
      setOther(data.other);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const updateGuild = useCallback(async (guildId: string, patch: GuildPatch) => {
    // Optimistic update on the local state — if the server applies
    // bundle defaults (enrolled=true → include+appear default true),
    // the response payload tells us the canonical values and we
    // re-sync.
    setEnrollable(prev => prev.map(g => g.guildId === guildId ? { ...g, ...patch } : g));
    setStatus('saving');
    try {
      const res = await fetch(`/api/me/guilds/${encodeURIComponent(guildId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const canonical: GuildPatch = await res.json();
      setEnrollable(prev => prev.map(g => g.guildId === guildId ? { ...g, ...canonical } : g));
      setStatus('ready');
    } catch {
      setStatus('error');
      // Re-fetch to bring the UI back to truth.
      refresh();
    }
  }, [refresh]);

  return { enrollable, other, status, updateGuild };
}
