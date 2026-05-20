import type { CardVariant } from '../types';
import { CANONICAL_VARIANTS, extractVariantLabel, variantChipLabel } from '../variants';
import { Popover } from './Popover';
import { VariantChip } from './VariantChip';

/**
 * Swap-variant popover used by binder rows (AvailableRow) and trade-
 * builder rows (TradeRow). Anchored to a caller-supplied trigger
 * (the variant pill on the row); opens a chip menu of every print
 * variant the catalog knows about for that card's family, with the
 * currently-active variant highlighted.
 *
 * Click a chip → caller's `onSelect(newCard)` fires with the
 * resolved `CardVariant` from `familyCandidates`. The popover
 * closes on selection; clicking the active variant is a no-op
 * (avoids accidental round-trip swaps when the user is just
 * browsing options).
 *
 * Variants that exist in CANONICAL_VARIANTS but have no print in
 * `familyCandidates` are rendered disabled — users see the
 * vocabulary but can't pick something that doesn't ship for this
 * card.
 *
 * Trade-builder flows in earlier shapes seeded a full search overlay
 * to "swap variant" — the user would search by basename, find a
 * different print, tap it, and get a duplicate row instead of a
 * swap. This component replaces that flow with in-place swap
 * semantics.
 */
interface VariantSwapPopoverProps {
  /** The currently-active card on the row. Used to find which chip
   *  to highlight + to identify the no-op tap. */
  currentCard: CardVariant;
  /** Every CardVariant in this card's family (every print variant
   *  the catalog has loaded). Typically from `byFamilyAll.get(fid)`. */
  familyCandidates: readonly CardVariant[];
  /** Called when the user picks a different variant. The popover
   *  closes immediately; no need for the caller to call `close()`. */
  onSelect: (newCard: CardVariant) => void;
  /** The clickable trigger — usually the row's variant pill.
   *  Wrapped in a button so click + keyboard + a11y land cleanly. */
  children: React.ReactNode;
  /** className applied to the trigger button. Lets the caller match
   *  the existing pill's layout (e.g. `shrink-0`). */
  triggerClassName?: string;
}

export function VariantSwapPopover({
  currentCard,
  familyCandidates,
  onSelect,
  children,
  triggerClassName = '',
}: VariantSwapPopoverProps) {
  const currentVariant = extractVariantLabel(currentCard.name);
  // Build a lookup of variant → CardVariant for the active picks.
  // A family might have multiple cards under the same variant label
  // (rare: data quirk where the scraper minted two records for the
  // same print); pick the first deterministic one.
  const byVariant = new Map<string, CardVariant>();
  for (const c of familyCandidates) {
    const v = extractVariantLabel(c.name);
    if (!byVariant.has(v)) byVariant.set(v, c);
  }
  // Render in CANONICAL_VARIANTS order — same vocabulary the picker
  // uses, so the row's popover and the picker's variant filter chips
  // line up visually.
  const orderedVariants = CANONICAL_VARIANTS.filter(v => byVariant.has(v));

  return (
    <Popover
      align="center"
      panelClassName="p-2"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Swap variant — currently ${variantChipLabel(currentVariant) || 'Standard'}`}
          className={`inline-flex items-center gap-0.5 ${triggerClassName}`}
        >
          {children}
          <Chevron open={open} />
        </button>
      )}
    >
      {({ close }) => (
        <div className="flex flex-col gap-2 min-w-[180px]">
          <span className="text-[10px] tracking-[0.1em] uppercase font-bold text-gray-500 px-1">
            Swap variant
          </span>
          <div className="flex flex-wrap gap-1.5">
            {orderedVariants.map(v => {
              const target = byVariant.get(v)!;
              const isActive = v === currentVariant;
              return (
                <VariantChip
                  key={v}
                  variant={v}
                  selected={isActive}
                  onClick={() => {
                    if (!isActive) onSelect(target);
                    close();
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </Popover>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`w-2.5 h-2.5 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
