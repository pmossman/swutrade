import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost } from '../services/apiClient';

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
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    enabled ? 'loading' : 'ready',
  );

  useEffect(() => {
    if (!enabled) {
      setFavorites([]);
      setStatus('ready');
      return;
    }
    let cancelled = false;
    (async () => {
      const result = await apiGet<{ favorites: Favorite[] }>('/api/me/favorites');
      if (cancelled) return;
      if (!result.ok) {
        setStatus('error');
        return;
      }
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
      return [result.data.favorite, ...without];
    });
    return { ok: true as const, favorite: result.data.favorite };
  }, []);

  const remove = useCallback(async (handle: string) => {
    const normalized = handle.toLowerCase().replace(/^@/, '');
    // Optimistically drop the row — the server is 204-on-success and
    // treats "not present" as the same desired end state, so rollback
    // would be masking a bug, not a real conflict.
    setFavorites(prev => prev.filter(f => f.handle.toLowerCase() !== normalized));
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
