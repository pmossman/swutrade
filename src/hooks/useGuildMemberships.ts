import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../services/apiClient';
import { createSingletonCache } from './sharedCache';

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

// Module-scoped cache: shared across hook instances for the SPA session.
// Lets return-navigation render the last-known guild list instantly while
// a background fetch revalidates. Any successful server response
// (loadLocal, refreshFromDiscord, updateGuild optimistic + canonical)
// overwrites the cache so it stays in sync with what's on screen.
interface GuildsCache {
  enrollable: GuildMembershipSummary[];
  other: GuildMembershipSummary[];
}
const cache = createSingletonCache<GuildsCache>();

/** Testing-only: reset the module-scoped cache between test cases. */
export function __resetGuildMembershipsCache() {
  cache.clear();
}

export function useGuildMemberships(): GuildMembershipsApi {
  const [enrollable, setEnrollable] = useState<GuildMembershipSummary[]>(
    () => cache.get()?.enrollable ?? [],
  );
  const [other, setOther] = useState<GuildMembershipSummary[]>(
    () => cache.get()?.other ?? [],
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>(
    () => (cache.has() ? 'ready' : 'loading'),
  );
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>('idle');

  // Per-call generation counter for `updateGuild`. Bumped on each
  // call; the canonical response only applies if no newer call has
  // started since. Without this, two same-render toggles (Enroll +
  // Include in rollups) race: the first PUT's canonical lands AFTER
  // the second optimistic apply and clobbers the user's second
  // toggle. Same shape as the saveCards race (audit
  // 13-mutation-patterns.md #1).
  const updateGenerationRef = useRef(0);

  const applyPayload = useCallback((data: {
    enrollable: GuildMembershipSummary[];
    other: GuildMembershipSummary[];
  }) => {
    // Defensive `?? []` against malformed payloads — happens in local
    // dev when Vite returns the SPA HTML for unproxied `/api/*` calls,
    // which apiClient lifts to `{ ok: true, data: {} }`. Without these
    // guards `setEnrollable(undefined)` corrupts state and any caller
    // that does `.filter()` on it crashes the view.
    const enrollable = data.enrollable ?? [];
    const other = data.other ?? [];
    cache.set({ enrollable, other });
    setEnrollable(enrollable);
    setOther(other);
  }, []);

  const loadLocal = useCallback(async () => {
    const result = await apiGet<{
      enrollable: GuildMembershipSummary[];
      other: GuildMembershipSummary[];
    }>('/api/me/guilds');
    if (!result.ok) {
      // If we already have cached data, keep showing it rather than
      // flipping to an error state — the user already saw something real.
      if (!cache.has()) setStatus('error');
      return;
    }
    applyPayload(result.data);
    setStatus('ready');
  }, [applyPayload]);

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
      // do this right now" bucket. Silent auto-refresh: swallow —
      // local data is already shown, no need to scare the user.
      // Manual click: show the banner.
      if (result.reason === 'already-resolved') {
        if (!opts.silent) setRefreshStatus('needs-reauth');
        else setRefreshStatus('idle');
        return;
      }
      if (!opts.silent) setRefreshStatus('error');
      else setRefreshStatus('idle');
      return;
    }
    applyPayload(result.data);
    setStatus('ready');
    setRefreshStatus('idle');
  }, [applyPayload]);

  // Initial load: local DB, then a one-shot Discord refresh per tab
  // session so the list picks up guilds the user has joined since
  // they last signed in without them clicking anything.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadLocal();
      if (cancelled) return;
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
  }, [loadLocal, refreshFromDiscord]);

  const updateGuild = useCallback(async (guildId: string, patch: GuildPatch) => {
    // Capture this call's generation. Any newer call that starts
    // before our PUT returns will bump the counter; we use that to
    // drop our stale canonical response.
    const gen = ++updateGenerationRef.current;

    // Optimistic update on the local state — if the server applies
    // bundle defaults (enrolled=true → include+appear default true),
    // the response payload tells us the canonical values and we
    // re-sync. Mirror both writes into the module cache so a sibling
    // mount of this hook doesn't see stale pre-patch data.
    setEnrollable(prev => {
      const next = prev.map(g => g.guildId === guildId ? { ...g, ...patch } : g);
      const current = cache.get();
      if (current) cache.set({ ...current, enrollable: next });
      return next;
    });
    setStatus('saving');
    const result = await apiPut<GuildPatch>(
      `/api/me/guilds/${encodeURIComponent(guildId)}`,
      patch,
    );

    // Stale-response guard: a newer updateGuild started after ours
    // (e.g. user toggled a second field). Apply nothing — letting our
    // canonical land here would overwrite the newer optimistic state.
    // The newer call's response carries forward.
    if (gen !== updateGenerationRef.current) {
      return;
    }

    if (!result.ok) {
      setStatus('error');
      // Re-fetch to bring the UI back to truth.
      loadLocal();
      return;
    }
    const canonical = result.data;
    setEnrollable(prev => {
      const next = prev.map(g => g.guildId === guildId ? { ...g, ...canonical } : g);
      const current = cache.get();
      if (current) cache.set({ ...current, enrollable: next });
      return next;
    });
    setStatus('ready');
  }, [loadLocal]);

  return { enrollable, other, status, refreshStatus, refreshFromDiscord, updateGuild };
}
