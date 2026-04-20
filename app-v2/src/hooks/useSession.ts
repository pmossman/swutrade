import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, ApiError } from '../lib/fetchClient';
import type {
  SessionPreview,
  SessionView,
  TradeCardSnapshot,
} from '../lib/trade';

type GetResponse =
  | { session: SessionView; preview?: undefined }
  | { preview: SessionPreview; session?: undefined };

interface UseSessionResult {
  session: SessionView | null;
  preview: SessionPreview | null;
  status: 'pending' | 'preview' | 'ready' | 'not-found' | 'error';
  error: ApiError | null;
  saveCards: (cards: TradeCardSnapshot[]) => Promise<void>;
  confirm: () => Promise<{ settled: boolean }>;
  cancel: () => Promise<void>;
  claim: () => Promise<void>;
  isMutating: boolean;
}

const KEY = (id: string) => ['session', id] as const;

export function useSession(id: string | undefined): UseSessionResult {
  const client = useQueryClient();

  const query = useQuery<GetResponse | null, ApiError>({
    queryKey: id ? KEY(id) : ['session', 'noop'],
    queryFn: async () => {
      if (!id) return null;
      try {
        return await apiGet<GetResponse>(`/api/sessions/${id}`);
      } catch (err) {
        if (err instanceof ApiError && err.reason === 'not-found') return null;
        throw err;
      }
    },
    enabled: !!id,
    // Session state is server-authoritative; refetch on focus to pick up
    // edits from the counterpart without full polling for now. Full
    // 2.5s polling ships in 1e (live trade) per v1's useSession pattern.
    refetchOnWindowFocus: 'always',
    staleTime: 5_000,
  });

  const session = query.data?.session ?? null;
  const preview = query.data?.preview ?? null;

  let status: UseSessionResult['status'];
  if (query.isLoading) status = 'pending';
  else if (query.isError) status = 'error';
  else if (session) status = 'ready';
  else if (preview) status = 'preview';
  else status = 'not-found';

  const editMut = useMutation<SessionView, ApiError, TradeCardSnapshot[]>({
    mutationFn: (cards) => apiPut<SessionView>(`/api/sessions/${id}/edit`, { cards }),
    onMutate: async (cards) => {
      if (!id) return;
      await client.cancelQueries({ queryKey: KEY(id) });
      const prev = client.getQueryData<GetResponse>(KEY(id));
      if (prev?.session) {
        const optimistic: GetResponse = {
          session: {
            ...prev.session,
            yourCards: cards,
            confirmedByViewer: false,
            confirmedByCounterpart: false,
            lastEditedByViewer: true,
            lastEditedAt: new Date().toISOString(),
          },
        };
        client.setQueryData(KEY(id), optimistic);
      }
      return { prev } as const;
    },
    onError: (_e, _cards, ctx) => {
      if (!id) return;
      const c = ctx as { prev?: GetResponse } | undefined;
      if (c?.prev) client.setQueryData(KEY(id), c.prev);
    },
    onSuccess: (view) => {
      if (!id) return;
      client.setQueryData(KEY(id), { session: view } as GetResponse);
    },
  });

  const confirmMut = useMutation<{ view: SessionView; settled: boolean }, ApiError>({
    mutationFn: () => apiPost(`/api/sessions/${id}/confirm`),
    onSuccess: (res) => {
      if (!id) return;
      client.setQueryData(KEY(id), { session: res.view } as GetResponse);
    },
  });

  const cancelMut = useMutation<{ view: SessionView }, ApiError>({
    mutationFn: () => apiPost(`/api/sessions/${id}/cancel`),
    onSuccess: (res) => {
      if (!id) return;
      client.setQueryData(KEY(id), { session: res.view } as GetResponse);
    },
  });

  const claimMut = useMutation<{ view: SessionView }, ApiError>({
    mutationFn: () => apiPost(`/api/sessions/${id}/claim`),
    onSuccess: (res) => {
      if (!id) return;
      client.setQueryData(KEY(id), { session: res.view } as GetResponse);
    },
  });

  return {
    session,
    preview,
    status,
    error: query.error ?? null,
    saveCards: async (cards) => {
      await editMut.mutateAsync(cards);
    },
    confirm: async () => {
      const r = await confirmMut.mutateAsync();
      return { settled: r.settled };
    },
    cancel: async () => {
      await cancelMut.mutateAsync();
    },
    claim: async () => {
      await claimMut.mutateAsync();
    },
    isMutating:
      editMut.isPending || confirmMut.isPending || cancelMut.isPending || claimMut.isPending,
  };
}
