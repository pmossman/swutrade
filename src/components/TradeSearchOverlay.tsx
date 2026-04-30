import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardVariant, PriceMode, TradeCard } from '../types';
import type { SelectionFilters } from '../hooks/useSelectionFilters';
import { ListCardPicker } from './ListCardPicker';
import { adjustPrice, getCardPrice } from '../services/priceService';

export type AccentColor = 'emerald' | 'blue';

const saberBarColors: Record<AccentColor, string> = {
  emerald: 'bg-gradient-to-b from-emerald-300 via-emerald-500 to-emerald-700 shadow-[0_0_12px_rgba(52,211,153,0.55)]',
  blue: 'bg-gradient-to-b from-blue-300 via-blue-500 to-blue-700 shadow-[0_0_12px_rgba(96,165,250,0.55)]',
};

const headerTextColors: Record<AccentColor, string> = {
  emerald: 'text-emerald-300',
  blue: 'text-blue-300',
};

const doneButtonColors: Record<AccentColor, string> = {
  emerald: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  blue: 'bg-blue-600 hover:bg-blue-500 text-white',
};

export interface SourceChipConfig {
  /** Stable identity; survives across re-renders so seeded chip
   *  activation matches the chip the parent intends. */
  id: string;
  /** Display label, e.g. "My available" / "They want". */
  label: string;
  /** Cards eligible for this source. The chip auto-hides when this
   *  drops to empty (parent does the qty-aware filtering). */
  cards: CardVariant[];
  /** When true, the chip renders even at cards.length === 0.
   *  Currently used for the Overlap chip — "0" is itself a useful
   *  signal ("no match pool; go look at 'They want' to discover
   *  what to source"). */
  alwaysVisible?: boolean;
}

export interface TradeSearchOverlaySeed {
  /** Pre-fill the search input. Useful for the swap-variant kebab. */
  query?: string;
  /** Chip ids to activate when the overlay opens. Useful for the
   *  shared-list landing handoff that deep-links into "They want". */
  activeChips?: string[];
}

interface TradeSearchOverlayProps {
  open: boolean;
  onDismiss: () => void;

  // Side identity
  label: string;
  accentColor: AccentColor;
  /** Counterpart handle when we're in a propose / shared-list context.
   *  Rendered as "for @alice" in the header to keep users oriented —
   *  the full-screen overlay was burying the "who am I trading with"
   *  context and making the picker feel disconnected from its home. */
  counterpartHandle?: string | null;

  // Card universe + filters
  allCards: CardVariant[];
  isLoading: boolean;
  /** Persisted variant + set selection filters. Owned by the parent
   *  so they survive overlay open/close. The unified picker uses its
   *  own internal filter state today, so this prop is reserved for a
   *  follow-up that wires the parent-owned filters back into the
   *  picker; for now the picker's persisted filters stand in. */
  filters: SelectionFilters;

  // Source chips — caller decides labels and which cards qualify.
  sourceChips: SourceChipConfig[];

  // Current side's trade rows — used for saved-qty badges + the
  // "picked so far" running summary in the header.
  cards: TradeCard[];
  percentage: number;
  priceMode: PriceMode;

  // Trade actions wired through to the picker's onAdd/onDecrement.
  onAdd: (card: CardVariant) => void;
  onChangeQty: (key: string, delta: number) => void;
  onRemove: (key: string) => void;

  /**
   * One-shot seed for the overlay's initial state. Set non-null to
   * apply (query and/or activeChips), then the overlay fires
   * `onSeedConsumed` so the parent can clear it.
   */
  seed?: TradeSearchOverlaySeed | null;
  onSeedConsumed?: () => void;
}

/**
 * Full-screen trade-builder card-picker overlay. Thin shell around
 * `<ListCardPicker selectionMode="specific">` — the unified picker
 * owns search / filter / browse / tile rendering / saved-qty badges,
 * while this component contributes the trade-builder-specific chrome:
 *
 *   - animated open / close (fade + slide)
 *   - ESC-to-dismiss
 *   - counterpart-context header ("Adding to · for @alice · Picked so far")
 *   - source chip row ("My available", "They want", "Overlap")
 *   - seed prop (one-shot initial query + active chips)
 */
export function TradeSearchOverlay({
  open,
  onDismiss,
  label,
  accentColor,
  counterpartHandle,
  allCards,
  cards,
  percentage,
  priceMode,
  sourceChips,
  onAdd,
  onChangeQty,
  onRemove,
  seed,
  onSeedConsumed,
}: TradeSearchOverlayProps) {
  const [activeChipIds, setActiveChipIds] = useState<readonly string[]>([]);
  // Seed-derived initial query — one-shot; the picker re-mounts each
  // time the overlay opens, so this fires fresh per open.
  const [seededInitialQuery, setSeededInitialQuery] = useState<string>('');

  // Auto-deactivate any chip whose pool drops to empty (e.g. user
  // pulled the last "My available" card into the trade). Without this
  // the grid would show "No cards match your filters" while a
  // gold-active chip was still selected.
  useEffect(() => {
    setActiveChipIds(prev => {
      const stillValid = prev.filter(id =>
        sourceChips.some(c => c.id === id && c.cards.length > 0),
      );
      return stillValid.length === prev.length ? prev : stillValid;
    });
  }, [sourceChips]);

  // Apply parent-supplied seed once, then notify so the parent can
  // null it out. Effect re-runs whenever seed identity changes.
  useEffect(() => {
    if (!seed) return;
    if (seed.query !== undefined) setSeededInitialQuery(seed.query);
    if (seed.activeChips !== undefined) setActiveChipIds(seed.activeChips);
    onSeedConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  // Reset the seeded query state when the overlay closes — next open
  // starts cold unless a fresh seed comes in.
  useEffect(() => {
    if (!open) setSeededInitialQuery('');
  }, [open]);

  const handleDismiss = useCallback(() => {
    onDismiss();
  }, [onDismiss]);

  // Esc handler — global so it works after focus moves to a tile.
  // Only attached while the overlay is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDismiss();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, handleDismiss]);

  // Browse pool: when source chips are active, scope the catalog
  // browse to the union of selected chip pools. Search continues to
  // hit the full catalog (the picker uses `allCards` for its search
  // index, separate from `browsePool`) so a user typing "Luke" still
  // finds a Luke that's outside the chip pool.
  const browsePool = useMemo(() => {
    if (activeChipIds.length === 0) return undefined;
    const pool: CardVariant[] = [];
    for (const id of activeChipIds) {
      const chip = sourceChips.find(c => c.id === id);
      if (chip) pool.push(...chip.cards);
    }
    return pool;
  }, [activeChipIds, sourceChips]);

  // Saved entries for the picker — productId-keyed (selectionMode is
  // 'specific' so the picker's badge lookup matches the trade row's
  // exact printing). The id round-trips via onDecrement so we can
  // route back to the right tradeCardKey.
  const savedEntries = useMemo(() => cards.map(tc => {
    const productId = tc.card.productId ?? '';
    return {
      id: productId,
      productId,
      qty: tc.qty,
    };
  }), [cards]);

  const handleDecrement = useCallback((id: string) => {
    const tc = cards.find(c => (c.card.productId ?? '') === id);
    if (!tc) return;
    if (tc.qty <= 1) onRemove(id);
    else onChangeQty(id, -1);
  }, [cards, onChangeQty, onRemove]);

  const visibleChips = sourceChips.filter(c => c.cards.length > 0 || c.alwaysVisible);

  // Running summary for the context header — lets the user see "what
  // I've picked so far on this side" without dismissing the overlay.
  const pickedCount = cards.reduce((s, c) => s + c.qty, 0);
  const pickedTotal = cards.reduce((s, c) => {
    const p = adjustPrice(getCardPrice(c.card, priceMode), percentage) ?? 0;
    return s + p * c.qty;
  }, 0);

  return (
    <div
      className={`fixed inset-0 z-40 bg-space-900 flex flex-col transition-all duration-200 ease-out ${
        open
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
    >
      {open && (
        <ListCardPicker
          // Re-mount when seed identity changes so the seeded query
          // takes effect on a fresh `useCardSearch` instance. Without
          // the key, initialQuery would only fire on first overlay
          // open.
          key={`seed-${seededInitialQuery}`}
          selectionMode={{ kind: 'specific' }}
          allCards={allCards}
          browsePool={browsePool}
          priceMode={priceMode}
          accent={accentColor}
          savedEntries={savedEntries}
          onPick={card => onAdd(card)}
          onDecrement={handleDecrement}
          onClose={handleDismiss}
          initialQuery={seededInitialQuery}
          actionTarget="trade"
          header={
            <div className="shrink-0 pt-3 pb-2 px-4 sm:px-6 max-w-6xl mx-auto w-full relative border-b border-space-800">
              <div
                className={`absolute left-4 sm:left-6 top-3 bottom-3 w-[3px] rounded-full ${saberBarColors[accentColor]}`}
                aria-hidden
              />
              <div className="pl-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[9px] tracking-[0.25em] text-gray-500 uppercase truncate">
                    Adding to
                    {counterpartHandle && (
                      <span className="normal-case tracking-normal text-gray-400">
                        {' '}· for <span className="text-gold">@{counterpartHandle}</span>
                      </span>
                    )}
                  </div>
                  <div className={`swu-display text-base ${headerTextColors[accentColor]}`}>{label}</div>
                  {pickedCount > 0 && (
                    <div className="text-[10px] text-gray-500 mt-0.5">
                      Picked so far: <strong className="text-gray-300">{pickedCount}</strong>
                      {pickedTotal > 0 && <> · <strong className="text-gray-300">${pickedTotal.toFixed(2)}</strong></>}
                    </div>
                  )}
                </div>
                <button
                  onClick={handleDismiss}
                  className={`shrink-0 px-3 py-1.5 rounded-lg font-bold text-xs uppercase tracking-wider transition-colors ${doneButtonColors[accentColor]}`}
                  aria-label="Close search"
                  title={counterpartHandle ? 'Back to proposal (Esc)' : 'Close (Esc)'}
                >
                  Done
                </button>
              </div>
            </div>
          }
          chips={visibleChips.length > 0 ? (
            // Renders inside the picker's filter region (under the
            // variant pills), so this fragment stays unwrapped — the
            // picker supplies the outer padding + spacing.
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-bold tracking-[0.15em] uppercase text-gray-500 mr-1">
                Show
              </span>
              {visibleChips.map(chip => (
                <SourceChip
                  key={chip.id}
                  active={activeChipIds.includes(chip.id)}
                  onClick={() => setActiveChipIds(prev =>
                    prev.includes(chip.id)
                      ? prev.filter(id => id !== chip.id)
                      : [...prev, chip.id],
                  )}
                  label={chip.label}
                  count={chip.cards.length}
                />
              ))}
            </div>
          ) : null}
        />
      )}
    </div>
  );
}

function SourceChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-colors border ${
        active
          ? 'bg-gold/20 text-gold-bright border-gold/50'
          : 'bg-space-800/60 text-gray-400 border-space-700 hover:text-gray-200 hover:border-gray-500'
      }`}
    >
      <span>{label}</span>
      <span className={`px-1.5 py-px rounded-full text-[10px] font-bold leading-none ${active ? 'bg-gold/30 text-gold-bright' : 'bg-space-700 text-gray-300'}`}>
        {count}
      </span>
    </button>
  );
}
