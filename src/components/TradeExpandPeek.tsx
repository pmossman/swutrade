import { useState } from 'react';
import { useTradeDetail, type CardSnapshot, type TradeDetail } from '../hooks/useTradeDetail';
import { cardImageUrl } from '../services/priceService';
import { extractBaseName, extractVariantLabel } from '../variants';
import { VariantBadge } from './VariantBadge';

/**
 * Inline expand-peek rendered beneath a trade row in My Trades lists.
 * Shows both sides' card images + any message + a link into the full
 * detail view. Click-to-expand on the parent list tracks a single
 * `expandedId`; this component is rendered below the toggled row.
 *
 * Viewer-centric labels: for a sent proposal the viewer offers the
 * `offeringCards`; for a received proposal they'd give the
 * `receivingCards`. We flip the labels accordingly so the peek reads
 * "You offer / You receive" (sent) or "You'd give / You'd get" (received).
 * The row chrome already fronts counterpart + counts; this just adds
 * a visual peek of the actual cards.
 */
export function TradeExpandPeek({
  proposalId,
  onOpenDetail,
}: {
  proposalId: string;
  /** Navigate to `/?trade=<id>`. Exposed as a callback rather than a
   *  raw href so callers can push history state their own way. */
  onOpenDetail: () => void;
}) {
  const { trade, status } = useTradeDetail(proposalId);

  if (status === 'loading' && !trade) {
    return (
      <div className="mt-2 rounded-lg border border-space-700 bg-space-900/40 px-3 py-3 text-[11px] text-gray-500">
        Loading trade…
      </div>
    );
  }
  if (status === 'not-found' || status === 'error' || !trade) {
    return (
      <div className="mt-2 rounded-lg border border-red-800/60 bg-red-950/20 px-3 py-3 text-[11px] text-red-300">
        Couldn't load this trade.{' '}
        <button
          type="button"
          onClick={onOpenDetail}
          className="underline font-semibold hover:text-red-200"
        >
          Open the detail page
        </button>
        .
      </div>
    );
  }

  const viewerIsSender = trade.viewerIsProposer;
  // The proposal row stores cards from the proposer's POV. For the
  // recipient viewer, the meaning flips: their `offeringCards` are
  // what the recipient would RECEIVE, and vice versa.
  const leftCards = trade.offeringCards;
  const rightCards = trade.receivingCards;
  const leftLabel = viewerIsSender ? 'You offer' : "You'd get";
  const rightLabel = viewerIsSender ? 'You receive' : "You'd give";

  return (
    <div className="mt-2 rounded-lg border border-space-700 bg-space-900/40 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <PeekSide label={leftLabel} cards={leftCards} accent="emerald" />
        <PeekSide label={rightLabel} cards={rightCards} accent="blue" />
      </div>
      {trade.message && (
        <div className="mt-3 rounded-md border border-space-700 bg-space-800/60 px-3 py-2">
          <div className="text-[10px] tracking-[0.15em] uppercase text-gray-500 font-bold mb-1">
            Message
          </div>
          <div className="text-[12px] text-gray-200 whitespace-pre-wrap break-words">
            {trade.message}
          </div>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onOpenDetail}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-gold hover:text-gold-bright transition-colors"
        >
          Open full details
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function PeekSide({
  label,
  cards,
  accent,
}: {
  label: string;
  cards: CardSnapshot[];
  accent: 'emerald' | 'blue';
}) {
  const labelColor = accent === 'emerald' ? 'text-emerald-300' : 'text-blue-300';
  const borderColor = accent === 'emerald' ? 'border-emerald-500/30' : 'border-blue-500/30';
  return (
    <div className={`rounded-md border ${borderColor} bg-space-800/40 p-2`}>
      <div className="flex items-baseline justify-between mb-2">
        <span className={`text-[10px] tracking-[0.18em] uppercase font-bold ${labelColor}`}>
          {label}
        </span>
        <span className="text-[10px] tabular-nums text-gray-500">
          {cards.reduce((n, c) => n + c.qty, 0)} {pluralize(cards.reduce((n, c) => n + c.qty, 0), 'card', 'cards')}
        </span>
      </div>
      {cards.length === 0 ? (
        <div className="text-[11px] text-gray-500 px-1 py-4 text-center">No cards</div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
          {cards.map((c, idx) => (
            <PeekTile key={`${c.productId}-${idx}`} snap={c} accent={accent} />
          ))}
        </div>
      )}
    </div>
  );
}

function PeekTile({
  snap,
  accent,
}: {
  snap: CardSnapshot;
  accent: 'emerald' | 'blue';
}) {
  const [errored, setErrored] = useState(false);
  const src = cardImageUrl(snap.productId, 'md');
  const qtyBg = accent === 'emerald'
    ? 'bg-black/85 text-white ring-1 ring-emerald-400/70'
    : 'bg-black/85 text-white ring-1 ring-blue-400/70';
  const baseName = extractBaseName(snap.name);
  const variantLabel = extractVariantLabel(snap.name) || snap.variant;
  return (
    <div
      className="relative rounded-md overflow-hidden border border-space-700 bg-space-900/80"
      title={`${snap.name}${snap.qty > 1 ? ` × ${snap.qty}` : ''}`}
    >
      <div className="relative w-full aspect-[5/7] bg-space-900">
        {src && !errored ? (
          <img
            src={src}
            alt={snap.name}
            loading="lazy"
            onError={() => setErrored(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-lg">?</div>
        )}
        {snap.qty > 1 && (
          <span className={`absolute top-1 right-1 min-w-[22px] h-[18px] px-1.5 rounded-full flex items-center justify-center text-[10px] font-bold tabular-nums shadow-lg ${qtyBg}`}>
            ×{snap.qty}
          </span>
        )}
      </div>
      <div className="px-1.5 py-1 leading-tight">
        <div className="text-[10px] text-gray-300 truncate">{baseName}</div>
        {variantLabel && (
          <VariantBadge
            variant={variantLabel}
            size="xs"
            className="inline-block max-w-full truncate align-middle"
          />
        )}
      </div>
    </div>
  );
}

function pluralize(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// Re-export TradeDetail so callers that only import the peek don't
// also need to pull the hook types for prop drilling elsewhere.
export type { TradeDetail };
