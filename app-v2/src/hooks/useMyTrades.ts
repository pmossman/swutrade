import { useQuery } from '@tanstack/react-query';
import { apiGet, ApiError } from '../lib/fetchClient';
import { useAuth } from './useAuth';
import type { SessionView } from '../lib/trade';

/*
 * Unified Trade stream — merges /api/trades/proposals and
 * /api/me/sessions into one list, sorted by activity. This is the
 * client-side realization of design §8.3: proposals + sessions stay
 * separate DB primitives, but the UI treats them as one `Trade`
 * with a shared state palette.
 */

export type TradeKind = 'proposal' | 'session';

export type TradeRowState =
  | 'shared'
  | 'shared-waiting'
  | 'pitched'
  | 'awaiting'
  | 'settled'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'countered';

export interface TradeRow {
  id: string;
  kind: TradeKind;
  state: TradeRowState;
  counterpartHandle: string | null;
  counterpartAvatarUrl: string | null;
  topCardName: string | null;
  offeringCount: number;
  receivingCount: number;
  lastActivityAt: string;
  /** Tap-target URL — routes to /t/:id for proposals, /s/:code for sessions. */
  href: string;
}

interface ProposalListItem {
  id: string;
  direction: 'sent' | 'received';
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'countered';
  offeringCount: number;
  receivingCount: number;
  topCard: { name: string; variant: string } | null;
  counterpart: { handle: string; username: string; avatarUrl: string | null } | null;
  updatedAt: string;
}

interface ProposalsResponse {
  proposals: ProposalListItem[];
}

interface SessionsResponse {
  sessions: SessionView[];
}

function mapProposal(p: ProposalListItem): TradeRow {
  let state: TradeRowState;
  if (p.status === 'pending') state = p.direction === 'sent' ? 'pitched' : 'awaiting';
  else if (p.status === 'accepted') state = 'settled';
  else state = p.status;
  return {
    id: p.id,
    kind: 'proposal',
    state,
    counterpartHandle: p.counterpart?.handle ?? null,
    counterpartAvatarUrl: p.counterpart?.avatarUrl ?? null,
    topCardName: p.topCard?.name ?? null,
    offeringCount: p.offeringCount,
    receivingCount: p.receivingCount,
    lastActivityAt: p.updatedAt,
    href: `/t/${p.id}`,
  };
}

function mapSession(s: SessionView): TradeRow {
  const state: TradeRowState = (() => {
    if (s.status === 'settled') return 'settled';
    if (s.status === 'cancelled') return 'cancelled';
    if (s.status === 'expired') return 'expired';
    return s.openSlot ? 'shared-waiting' : 'shared';
  })();
  const topCard = [...s.yourCards, ...s.theirCards].reduce<{
    name: string;
    unitPrice: number | null;
  } | null>((best, c) => {
    const bestP = best?.unitPrice ?? -1;
    const cP = c.unitPrice ?? -1;
    return cP > bestP ? { name: c.name, unitPrice: c.unitPrice } : best;
  }, null);
  return {
    id: s.id,
    kind: 'session',
    state,
    counterpartHandle: s.counterpart?.handle ?? null,
    counterpartAvatarUrl: s.counterpart?.avatarUrl ?? null,
    topCardName: topCard?.name ?? null,
    offeringCount: s.yourCards.reduce((n, c) => n + c.qty, 0),
    receivingCount: s.theirCards.reduce((n, c) => n + c.qty, 0),
    lastActivityAt: s.lastEditedAt,
    href: `/s/${s.id}`,
  };
}

export function useMyTrades() {
  const auth = useAuth();
  const enabled = !!auth.user;

  const proposals = useQuery<ProposalsResponse, ApiError>({
    queryKey: ['my-trades', 'proposals'],
    queryFn: () => apiGet<ProposalsResponse>('/api/trades/proposals'),
    enabled,
    staleTime: 15_000,
  });

  const sessions = useQuery<SessionsResponse, ApiError>({
    queryKey: ['my-trades', 'sessions'],
    queryFn: () => apiGet<SessionsResponse>('/api/me/sessions'),
    enabled,
    staleTime: 15_000,
  });

  const rows: TradeRow[] = [
    ...(proposals.data?.proposals.map(mapProposal) ?? []),
    ...(sessions.data?.sessions.map(mapSession) ?? []),
  ].sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));

  const needsResponse = rows.filter((r) => r.state === 'awaiting');

  const status: 'pending' | 'error' | 'ready' =
    !enabled
      ? 'ready'
      : proposals.isLoading || sessions.isLoading
        ? 'pending'
        : proposals.isError || sessions.isError
          ? 'error'
          : 'ready';

  return { rows, needsResponse, status };
}
