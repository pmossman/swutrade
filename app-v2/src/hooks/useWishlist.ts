import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut, ApiError } from '../lib/fetchClient';
import { useAuth } from './useAuth';

export interface WishlistItem {
  id: string;
  familyId: string;
  qty: number;
  restriction: { mode: 'any' } | { mode: 'restricted'; variants: string[] };
  note?: string;
  isPriority?: boolean;
  addedAt: number;
}

const KEY = ['sync', 'wants'] as const;

async function fetchWishlist(): Promise<WishlistItem[]> {
  return await apiGet<WishlistItem[]>('/api/sync/wants');
}

export function useWishlist() {
  const auth = useAuth();
  const client = useQueryClient();

  const enabled = !!auth.user && !auth.user.isAnonymous;

  const query = useQuery<WishlistItem[], ApiError>({
    queryKey: KEY,
    queryFn: fetchWishlist,
    enabled,
  });

  const mutation = useMutation<WishlistItem[], ApiError, WishlistItem[]>({
    mutationFn: (next) => apiPut<WishlistItem[]>('/api/sync/wants', next),
    onMutate: async (next) => {
      await client.cancelQueries({ queryKey: KEY });
      const prev = client.getQueryData<WishlistItem[]>(KEY);
      client.setQueryData(KEY, next);
      return { prev } as const;
    },
    onError: (_err, _next, ctx) => {
      const c = ctx as { prev?: WishlistItem[] } | undefined;
      if (c?.prev) client.setQueryData(KEY, c.prev);
    },
    onSettled: () => client.invalidateQueries({ queryKey: KEY }),
  });

  function add(familyId: string, qty = 1) {
    const items = query.data ?? [];
    // "Any variant" dedup: one entry per familyId with mode:'any'.
    // Restricted variants live as separate rows (same family, different
    // restriction). Phase 1c ships with any-variant only.
    const existing = items.find(
      (i) => i.familyId === familyId && i.restriction.mode === 'any',
    );
    if (existing) {
      mutation.mutate(
        items.map((i) =>
          i.id === existing.id ? { ...i, qty: Math.min(99, i.qty + qty) } : i,
        ),
      );
      return;
    }
    mutation.mutate([
      ...items,
      {
        id: crypto.randomUUID(),
        familyId,
        qty: Math.min(99, Math.max(1, qty)),
        restriction: { mode: 'any' },
        addedAt: Date.now(),
      },
    ]);
  }

  function setQty(id: string, qty: number) {
    const items = query.data ?? [];
    if (qty <= 0) {
      mutation.mutate(items.filter((i) => i.id !== id));
      return;
    }
    mutation.mutate(
      items.map((i) => (i.id === id ? { ...i, qty: Math.min(99, qty) } : i)),
    );
  }

  function togglePriority(id: string) {
    const items = query.data ?? [];
    mutation.mutate(
      items.map((i) => (i.id === id ? { ...i, isPriority: !i.isPriority } : i)),
    );
  }

  function remove(id: string) {
    const items = query.data ?? [];
    mutation.mutate(items.filter((i) => i.id !== id));
  }

  return {
    items: query.data ?? [],
    status: query.status,
    error: query.error,
    canWrite: enabled,
    add,
    setQty,
    togglePriority,
    remove,
    isMutating: mutation.isPending,
  };
}
