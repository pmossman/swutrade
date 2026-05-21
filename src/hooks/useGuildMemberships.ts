import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../services/apiClient';
import { createPersistentSingletonCache } from './sharedCache';
import { useResource } from './useResource';

export interface GuildMembershipSummary {
  guildId: string;
  guildName: string;
  guildIcon: string | null;
  canManage: boolean;
  enrolled: boolean;
  includeInRollups: boolean;
  appearInQueries: boolean;
  /** Count of SWUTrade users enrolled in this guild (not total Discord
   *  server members — that would require a live bot query). Zero when
   *  no one has opted in yet. */
  memberCount: number;
}

export type GuildPatch = Partial<Pick<
  GuildMembershipSummary,
  'enrolled' | 'includeInRollups' | 'appearInQueries'
>>;

export type RefreshStatus = 'idle' | 'refreshing' | 'needs-reauth' | 'error';

export interface GuildMembershipsApi {
  /** Guilds where SWUTrade's bot is installed — user can enroll. */
  enrollable: GuildMembershipSummary[];
  /** Guilds where the bot isn't installed — informational only. */
  other: GuildMembershipSummary[];
  status: 'loading' | 'ready' | 'saving' | 'error';
  /** State of the most recent Discord-side refresh. */
  refreshStatus: RefreshStatus;
  /**
   * Re-pull the guild list from Discord (re-hits /users/@me/guilds).
   * Pass `{ silent: true }` for the background auto-refresh path —
   * errors won't surface a re-auth banner. The manual Refresh button
   * leaves `silent` unset so the banner shows if the token is gone.
   */
  refreshFromDiscord: (opts?: { silent?: boolean }) => Promise<void>;
  /** PUT a patch for a specific guild, optimistically update locally. */
  updateGuild: (guildId: string, patch: GuildPatch) => Promise<void>;
}

// Session-scoped flag: once we've auto-refreshed from Discord in this
// tab, don't do it again. Avoids spamming Discord if the user bounces
// in/out of Settings. Manual button clicks always refresh.
const AUTO_REFRESHED_KEY = 'swu-settings-auto-refreshed';

// Module-scoped cache: shared across hook instances for the SPA session
// AND persisted to localStorage. Lets return-navigation render the
// last-known guild list instantly while a background fetch revalidates;
// the persisted layer extends that to cold loads too. Any successful
// server response (initial fetch, refreshFromDiscord, updateGuild
// optimistic + canonical) overwrites the cache so it stays in sync
// with what's on screen.
interface GuildsCache {
  enrollable: GuildMembershipSummary[];
  other: GuildMembershipSummary[];
}
const cache = createPersistentSingletonCache<GuildsCache>('swu.cache.guilds.v1', {
  validate: raw => {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as { enrollable?: unknown; other?: unknown };
    if (!Array.isArray(obj.enrollable) || !Array.isArray(obj.other)) return null;
    for (const list of [obj.enrollable, obj.other]) {
      for (const g of list) {
        if (!g || typeof g !== 'object') return null;
        const guild = g as Record<string, unknown>;
        if (typeof guild.guildId !== 'string' || typeof guild.guildName !== 'string') return null;
      }
    }
    return {
      enrollable: obj.enrollable as GuildMembershipSummary[],
      other: obj.other as GuildMembershipSummary[],
    };
  },
});

/** Testing-only: reset the module-scoped cache between test cases. */
export function __resetGuildMembershipsCache() {
  cache.clear();
}

// Defensive `?? []` against malformed payloads — happens in local dev
// when Vite returns the SPA HTML for unproxied `/api/*` calls, which
// apiClient lifts to `{ ok: true, data: {} }`. Without these guards
// the state goes undefined and any caller doing `.filter()` crashes.
function normalizePayload(data: { enrollable?: GuildMembershipSummary[]; other?: GuildMembershipSummary[] }): GuildsCache {
  return {
    enrollable: data.enrollable ?? [],
    other: data.other ?? [],
  };
}

export function useGuildMemberships(): GuildMembershipsApi {
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>('idle');

  // useResource owns the data + status + gen-counter race protection.
  // The persistent cache is mirrored via useResource's `cache.write`
  // hook so sibling instances stay in sync; the initial seed comes
  // from cache.get() so return-navigation renders instantly.
  const resource = useResource<GuildsCache>({
    initial: cache.get() ?? null,
    revalidateOnMount: true,
    fetcher: async () => {
      const result = await apiGet<{
        enrollable: GuildMembershipSummary[];
        other: GuildMembershipSummary[];
      }>('/api/me/guilds');
      return result.ok ? normalizePayload(result.data) : null;
    },
    cache: { write: next => cache.set(next) },
  });

  const refreshFromDiscord = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setRefreshStatus('refreshing');
    const result = await apiPost<{
      enrollable: GuildMembershipSummary[];
      other: GuildMembershipSummary[];
    }>('/api/me/guilds/refresh');
    if (!result.ok) {
      // 409 on refresh means the Discord access token is expired /
      // revoked / never stored (legacy session). The apiClient maps
      // that to `already-resolved`, which is the idiomatic "you can't
      // do this right now" bucket. Silent auto-refresh: swallow.
      // Manual click: show the banner.
      if (result.reason === 'already-resolved') {
        setRefreshStatus(opts.silent ? 'idle' : 'needs-reauth');
        return;
      }
      setRefreshStatus(opts.silent ? 'idle' : 'error');
      return;
    }
    resource.setData(normalizePayload(result.data));
    resource.setStatus('ready');
    setRefreshStatus('idle');
  }, [resource]);

  // Once-per-tab auto-refresh from Discord so the list picks up guilds
  // the user has joined since they last signed in without them
  // clicking anything. Initial fetch from /api/me/guilds is handled by
  // useResource's auto-mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === 'undefined') return;
      try {
        if (window.sessionStorage.getItem(AUTO_REFRESHED_KEY) === '1') return;
        window.sessionStorage.setItem(AUTO_REFRESHED_KEY, '1');
      } catch {
        // sessionStorage can throw in private mode — fall through and refresh anyway.
      }
      if (cancelled) return;
      await refreshFromDiscord({ silent: true });
    })();
    return () => { cancelled = true; };
  }, [refreshFromDiscord]);

  const updateGuild = useCallback(async (guildId: string, patch: GuildPatch) => {
    await resource.runMutation({
      optimistic: current => ({
        ...current,
        enrollable: current.enrollable.map(g =>
          g.guildId === guildId ? { ...g, ...patch } : g,
        ),
      }),
      request: () => apiPut<GuildPatch>(
        `/api/me/guilds/${encodeURIComponent(guildId)}`,
        patch,
      ),
      // Server applies bundle defaults (enrolled=true → include+appear
      // default true); the response carries the canonical patch and
      // we re-sync that row from it.
      applyCanonical: (current, canonical) => ({
        ...current,
        enrollable: current.enrollable.map(g =>
          g.guildId === guildId ? { ...g, ...canonical } : g,
        ),
      }),
    });
  }, [resource]);

  return {
    enrollable: resource.data?.enrollable ?? [],
    other: resource.data?.other ?? [],
    status: resource.status,
    refreshStatus,
    refreshFromDiscord,
    updateGuild,
  };
}
