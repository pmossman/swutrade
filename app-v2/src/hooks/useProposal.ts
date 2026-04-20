import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../lib/fetchClient';
import type { TradeCardSnapshot } from '../lib/trade';

export type ProposalStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'countered';

export interface ProposalParty {
  handle: string;
  username: string;
  avatarUrl: string | null;
}

export interface ProposalDetail {
  id: string;
  status: ProposalStatus;
  counterOfId: string | null;
  offeringCards: TradeCardSnapshot[];
  receivingCards: TradeCardSnapshot[];
  message: string | null;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
  proposer: ProposalParty | null;
  recipient: ProposalParty | null;
  viewerIsProposer: boolean;
  viewerIsRecipient: boolean;
  events: Array<{ id: string; type: string; createdAt: string }>;
}

const KEY = (id: string) => ['proposal', id] as const;

export function useProposal(id: string | undefined) {
  const client = useQueryClient();

  const query = useQuery<ProposalDetail, ApiError>({
    queryKey: id ? KEY(id) : ['proposal', 'noop'],
    queryFn: () => apiGet<ProposalDetail>(`/api/trades/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });

  const acceptMut = useMutation<ProposalDetail, ApiError>({
    mutationFn: () => apiPost(`/api/trades/${id}/accept`),
    onSuccess: (data) => {
      if (!id) return;
      client.setQueryData(KEY(id), data);
    },
  });

  const declineMut = useMutation<ProposalDetail, ApiError>({
    mutationFn: () => apiPost(`/api/trades/${id}/decline`),
    onSuccess: (data) => {
      if (!id) return;
      client.setQueryData(KEY(id), data);
    },
  });

  const cancelMut = useMutation<ProposalDetail, ApiError>({
    mutationFn: () => apiPost(`/api/trades/${id}/cancel`),
    onSuccess: (data) => {
      if (!id) return;
      client.setQueryData(KEY(id), data);
    },
  });

  return {
    proposal: query.data ?? null,
    status: query.status,
    error: query.error ?? null,
    accept: () => acceptMut.mutateAsync(),
    decline: () => declineMut.mutateAsync(),
    cancel: () => cancelMut.mutateAsync(),
    isMutating: acceptMut.isPending || declineMut.isPending || cancelMut.isPending,
  };
}
