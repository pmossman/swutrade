import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut, ApiError } from '../lib/fetchClient';
import { useAuth } from './useAuth';

export interface BinderItem {
  id: string;
  productId: string;
  qty: number;
  note?: string;
  addedAt: number;
}

const KEY = ['sync', 'available'] as const;

async function fetchBinder(): Promise<BinderItem[]> {
  return await apiGet<BinderItem[]>('/api/sync/available');
}

export function useBinder() {
  const auth = useAuth();
  const client = useQueryClient();

  const enabled = !!auth.user && !auth.user.isAnonymous;

  const query = useQuery<BinderItem[], ApiError>({
    queryKey: KEY,
    queryFn: fetchBinder,
    enabled,
  });

  const mutation = useMutation<BinderItem[], ApiError, BinderItem[]>({
    mutationFn: (next) => apiPut<BinderItem[]>('/api/sync/available', next),
    onMutate: async (next) => {
      await client.cancelQueries({ queryKey: KEY });
      const prev = client.getQueryData<BinderItem[]>(KEY);
      client.setQueryData(KEY, next);
      return { prev } as const;
    },
    onError: (_err, _next, ctx) => {
      const c = ctx as { prev?: BinderItem[] } | undefined;
      if (c?.prev) client.setQueryData(KEY, c.prev);
    },
    onSettled: () => client.invalidateQueries({ queryKey: KEY }),
  });

  function add(productId: string, qty = 1) {
    const items = query.data ?? [];
    const existing = items.find((i) => i.productId === productId);
    if (existing) {
      mutation.mutate(
        items.map((i) =>
          i.productId === productId
            ? { ...i, qty: Math.min(99, i.qty + qty) }
            : i,
        ),
      );
      return;
    }
    mutation.mutate([
      ...items,
      {
        id: crypto.randomUUID(),
        productId,
        qty: Math.min(99, Math.max(1, qty)),
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
    remove,
    isMutating: mutation.isPending,
  };
}
