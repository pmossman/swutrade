import { useMutation } from '@tanstack/react-query';
import { apiPost, ApiError } from '../lib/fetchClient';
import type { TradeCardSnapshot } from '../lib/trade';

interface ProposeRequest {
  recipientHandle: string;
  offeringCards: TradeCardSnapshot[];
  receivingCards: TradeCardSnapshot[];
  message?: string;
}

interface ProposeResponse {
  id: string;
  deliveryStatus: 'pending' | 'delivered' | 'failed';
}

export function usePropose() {
  return useMutation<ProposeResponse, ApiError, ProposeRequest>({
    mutationFn: (body) => apiPost<ProposeResponse>('/api/trades/propose', body),
  });
}
