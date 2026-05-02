import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost } from '../services/apiClient';
import { createSingletonCache } from './sharedCache';

export interface Favorite {
  userId: string;
  handle: string;
  username: string;
  avatarUrl: string | null;
  note: string | null;
  createdAt: string;
}

export interface FavoritesApi {
  favorites: Favorite[];
  status: 'loading' | 'ready' | 'error';
  /** Add `handle` to the viewer's favorites. Server resolves handle →
   *  user; rejects ghosts / self-favorite. Optimistically prepends the
   *  canonical row returned by the server. */
  add: (handle: string) => Promise<{ ok: true; favorite: Favorite } | { ok: false; reason: string }>;
  /** Remove `handle` from the viewer's favorites. Idempotent — removes
   *  the local row whether or not the server returns 204 (server's
   *  desired-end-state semantics match ours). */
  remove: (handle: string) => Promise<void>;
  /** True if `handle` appears in the favorites list. Case-insensitive;
   *  comparison is over the stored handle which is always lowercase. */
  isFavorite: (handle: string) => boolean;
}

// Module-scoped cache: shared across hook instances for the SPA
// session. HandlePickerDialog mounts useFavorites on every open even
// when HomeView already mounted it; without the cache we'd pay an
// extra `/api/me/favorites` round-trip per open. Audit
// 07-performance #5.
const cache = createSingletonCache<Favorite[]>();

/** Testing-only: reset the module-scoped cache between test cases. */
export function __resetFavoritesCache() {
  cache.clear();
}

/**
 * Explicit trading-partner bookmarks. Companion to `useRecentPartners`
 * (auto-populated from proposal history); Favorites covers the
 * "I know @bob, I want to trade with him, but we haven't traded yet"
 * case. Surfaces on Home's "Your trading partners" module and via a
 * star toggle on ProfileView.
 *
 * Signed-in only — ghosts have `user.isAnonymous` and the server
 * endpoint 401s. Callers should only mount this when `!!user`.
 */
export function useFavorites(enabled: boolean): FavoritesApi {
  const [favorites, setFavorites] = useState<Favorite[]>(
    () => (enabled ? cache.get() ?? [] : []),
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(() => {
    if (!enabled) return 'ready';
    return cache.has() ? 'ready' : 'loading';
  });

  useEffect(() => {
    if (!enabled) {
      // Sign-out boundary: drop the cached list so the next signed-in
      // mount fetches fresh (could be a different user).
      cache.clear();
      setFavorites([]);
      setStatus('ready');
      return;
    }
    let cancelled = false;
    (async () => {
      const result = await apiGet<{ favorites: Favorite[] }>('/api/me/favorites');
      if (cancelled) return;
      if (!result.ok) {
        // If we have cached data, keep showing it rather than flipping
        // to error — the user already saw something real.
        if (!cache.has()) setStatus('error');
        return;
      }
      cache.set(result.data.favorites);
      setFavorites(result.data.favorites);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, [enabled]);

  const add = useCallback(async (handle: string) => {
    const normalized = handle.toLowerCase().replace(/^@/, '');
    const result = await apiPost<{ favorite: Favorite }>('/api/me/favorites', { handle: normalized });
    if (!result.ok) {
      return { ok: false as const, reason: result.reason };
    }
    // Insert at the head (matches server's `ORDER BY createdAt DESC`)
    // and dedupe in case of an idempotent re-favorite.
    setFavorites(prev => {
      const without = prev.filter(f => f.userId !== result.data.favorite.userId);
      const next = [result.data.favorite, ...without];
      cache.set(next);
      return next;
    });
    return { ok: true as const, favorite: result.data.favorite };
  }, []);

  const remove = useCallback(async (handle: string) => {
    const normalized = handle.toLowerCase().replace(/^@/, '');
    // Optimistically drop the row — the server is 204-on-success and
    // treats "not present" as the same desired end state, so rollback
    // would be masking a bug, not a real conflict.
    setFavorites(prev => {
      const next = prev.filter(f => f.handle.toLowerCase() !== normalized);
      cache.set(next);
      return next;
    });
    await apiDelete(`/api/me/favorites/${encodeURIComponent(normalized)}`);
  }, []);

  const isFavorite = useCallback(
    (handle: string) => {
      const normalized = handle.toLowerCase().replace(/^@/, '');
      return favorites.some(f => f.handle.toLowerCase() === normalized);
    },
    [favorites],
  );

  return { favorites, status, add, remove, isFavorite };
}
