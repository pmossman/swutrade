import type { TradeStatus } from '../../hooks/useTradeDetail';

type Size = 'md' | 'sm';

interface StatusBadgeProps {
  status: TradeStatus;
  /** `sm` (default) is the lighter row-chip variant used in trade-history
   *  rows. `md` is the heavier detail-header variant used on the trade
   *  detail page. Both share structure + label; only opacity differs. */
  size?: Size;
}

/**
 * Single source for the pending/accepted/declined/cancelled/expired/
 * countered chips. Previously duplicated between TradesHistoryView and
 * TradeDetailView with a slight opacity delta; the `size` prop preserves
 * that visual distinction without the code duplication.
 */
export function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const palette = VARIANTS[size][status];
  return (
    <span className={`px-2 py-0.5 rounded-md border text-[10px] tracking-wider uppercase font-bold shrink-0 ${palette.cls}`}>
      {palette.label}
    </span>
  );
}

type PaletteEntry = { label: string; cls: string };

const VARIANTS: Record<Size, Record<TradeStatus, PaletteEntry>> = {
  sm: {
    pending:   { label: 'Pending',   cls: 'bg-gold/15 border-gold/30 text-gold' },
    accepted:  { label: 'Accepted',  cls: 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200' },
    declined:  { label: 'Declined',  cls: 'bg-red-500/15 border-red-400/40 text-red-200' },
    cancelled: { label: 'Cancelled', cls: 'bg-space-700 border-space-600 text-gray-400' },
    expired:   { label: 'Expired',   cls: 'bg-space-700 border-space-600 text-gray-400' },
    countered: { label: 'Countered', cls: 'bg-purple-500/15 border-purple-400/40 text-purple-200' },
    // Distinct from countered — promoted means "the proposal became a
    // shared trade session." Cyan ties it visually to the session
    // entry surfaces (cyan accents on shared-trade chrome).
    promoted:  { label: 'Promoted',  cls: 'bg-cyan-500/15 border-cyan-400/40 text-cyan-200' },
  },
  md: {
    pending:   { label: 'Pending',   cls: 'bg-gold/20 border-gold/40 text-gold' },
    accepted:  { label: 'Accepted',  cls: 'bg-emerald-500/20 border-emerald-400/50 text-emerald-200' },
    declined:  { label: 'Declined',  cls: 'bg-red-500/20 border-red-400/50 text-red-200' },
    cancelled: { label: 'Cancelled', cls: 'bg-space-700/60 border-space-600 text-gray-400' },
    expired:   { label: 'Expired',   cls: 'bg-space-700/60 border-space-600 text-gray-400' },
    countered: { label: 'Countered', cls: 'bg-purple-500/20 border-purple-400/50 text-purple-200' },
    promoted:  { label: 'Promoted',  cls: 'bg-cyan-500/20 border-cyan-400/50 text-cyan-200' },
  },
};
