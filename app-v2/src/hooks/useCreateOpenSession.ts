import { useMutation } from '@tanstack/react-query';
import { apiPost, ApiError } from '../lib/fetchClient';
import type { TradeCardSnapshot } from '../lib/trade';

interface CreateOpenResponse {
  id: string;
  ghost?: { id: string; handle: string; username: string };
}

interface CreateOpenPayload {
  initialCards?: TradeCardSnapshot[];
  counterpartInitialCards?: TradeCardSnapshot[];
}

/*
 * Mints an open-slot session server-side. Returns the session id so
 * the caller can navigate to /s/:id. If the caller has no auth cookie,
 * the server mints a ghost user + sets the iron-session cookie in the
 * response — subsequent requests carry the cookie automatically.
 *
 * Design §5.2: eager session creation on FAB-tap, no offline queue,
 * create-open failure surfaces as an inline Retry per §10 sub-phase
 * 1d exit criteria.
 */
export function useCreateOpenSession() {
  return useMutation<CreateOpenResponse, ApiError, CreateOpenPayload | void>({
    mutationFn: (payload) =>
      apiPost<CreateOpenResponse>(
        '/api/sessions/create-open',
        payload ?? { initialCards: [], counterpartInitialCards: [] },
      ),
  });
}
