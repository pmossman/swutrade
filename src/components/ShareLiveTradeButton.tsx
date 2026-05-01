import { useCallback, useState } from 'react';
import { apiPost } from '../services/apiClient';
import { useNavigation } from '../contexts/NavigationContext';
import type { TradeCard } from '../types';
import type { CardSnapshot } from '../hooks/useTradeDetail';
import { extractVariantLabel as extractVariant } from '../variants';

/**
 * "Invite someone" action for the trade builder's action strip.
 * Opens a shared canvas + QR/link so someone can scan or follow the
 * link to join the trade you're already building. Works for both
 * signed-in and anonymous users:
 *
 *   - Signed-in: POSTs /api/sessions/create-open, seeds both sides
 *     of the new session from the current builder cards, navigates
 *     into `/s/<id>` where the user sees their QR + shareable link.
 *   - Anonymous: the same endpoint mints a ghost user server-side
 *     (new iron-session cookie set on the response), so the
 *     scanner-is-anonymous-too case works end-to-end. The ghost
 *     can sign in later to save the session via the OAuth-callback
 *     merge — an in-session banner nudges them.
 *
 * Seeds both halves of the current calculator into the session:
 * the creator's side (`yourCards`) plus the counterpart's side
 * (`theirCards`) as a pre-populated suggestion. The scanner can
 * edit their half once they claim, so the counterpart-side seed is
 * a starting point, not a constraint. This mirrors the calculator's
 * mental model — "here's the trade I was thinking about" — rather
 * than dropping the counterpart-side work the user just did.
 */
export function ShareLiveTradeButton({
  yourCards,
  theirCards,
}: {
  yourCards: TradeCard[];
  theirCards: TradeCard[];
}) {
  const nav = useNavigation();
  const [starting, setStarting] = useState(false);

  const handleClick = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    try {
      const initialCards = yourCards.map(toSnapshot);
      const counterpartInitialCards = theirCards.map(toSnapshot);
      const result = await apiPost<{ id: string }>('/api/sessions/create-open', {
        initialCards,
        counterpartInitialCards,
      });
      if (result.ok) nav.toSession(result.data.id);
    } finally {
      setStarting(false);
    }
  }, [nav, starting, yourCards, theirCards]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={starting}
      title="Invite someone to edit this trade together — generates a QR + link you can share in person or remotely"
      className="shrink-0 inline-flex items-center gap-1 px-2.5 h-8 rounded-md border border-cyan-500/50 text-cyan-200 hover:border-cyan-400 hover:bg-cyan-950/40 text-xs font-semibold transition-colors disabled:opacity-60"
    >
      <QRGlyph className="w-3.5 h-3.5" />
      {starting ? 'Starting…' : 'Invite someone'}
    </button>
  );
}

function toSnapshot(tc: TradeCard): CardSnapshot {
  return {
    productId: tc.card.productId || tc.card.name,
    name: tc.card.name,
    variant: tc.card.name.includes('(') ? extractVariant(tc.card.name) : 'Standard',
    qty: tc.qty,
    unitPrice: tc.card.marketPrice ?? null,
  };
}

// Local extractVariant deleted — the canonical extractVariantLabel
// from ../variants is now imported above. The local copy missed the
// `(\d+) → 'Regional'` rule, so share-link snapshots rendered
// TCGPlayer collector numbers as variant labels (audit
// 14-domain-rendering #2).

function QRGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <rect x="2" y="2" width="4" height="4" rx="0.5" />
      <rect x="10" y="2" width="4" height="4" rx="0.5" />
      <rect x="2" y="10" width="4" height="4" rx="0.5" />
      <rect x="10" y="10" width="2" height="2" />
      <rect x="13" y="10" width="1" height="1" />
      <rect x="10" y="13" width="1" height="1" />
      <rect x="13" y="13" width="1" height="1" />
    </svg>
  );
}
