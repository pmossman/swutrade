/*
 * Shared trade-adjacent types + small helpers. Types mirror v1's
 * `lib/sessions.ts::SessionView` + `TradeCardSnapshot`. Types are
 * redeclared here (not imported from root) because v2's client
 * never pulls from lib/ at the type layer — only api/* does.
 */

export interface TradeCardSnapshot {
  productId: string;
  name: string;
  variant: string;
  qty: number;
  unitPrice: number | null;
}

export type SessionStatus = 'active' | 'settled' | 'cancelled' | 'expired';

export interface SessionCounterpart {
  userId: string;
  handle: string;
  username: string;
  avatarUrl: string | null;
  isAnonymous: boolean;
}

export interface SessionView {
  id: string;
  status: SessionStatus;
  viewer: { userId: string };
  counterpart: SessionCounterpart | null;
  openSlot: boolean;
  yourCards: TradeCardSnapshot[];
  theirCards: TradeCardSnapshot[];
  confirmedByViewer: boolean;
  confirmedByCounterpart: boolean;
  lastEditedByViewer: boolean;
  lastEditedAt: string;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  expiresAt: string;
}

export interface SessionPreview {
  id: string;
  creator: {
    handle: string;
    username: string;
    avatarUrl: string | null;
    isAnonymous: boolean;
  };
  creatorCardCount: number;
  createdAt: string;
  expiresAt: string;
}

/** Sum of qty * unitPrice, treating null prices as 0. */
export function totalOf(cards: ReadonlyArray<TradeCardSnapshot>): number {
  let total = 0;
  for (const c of cards) {
    if (c.unitPrice == null) continue;
    total += c.unitPrice * c.qty;
  }
  return Math.round(total * 100) / 100;
}

/** Qty-weighted count of cards with a null unit price. */
export function missingPriceCount(cards: ReadonlyArray<TradeCardSnapshot>): number {
  let n = 0;
  for (const c of cards) if (c.unitPrice == null) n += c.qty;
  return n;
}
