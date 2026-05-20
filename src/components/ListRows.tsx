import { memo } from 'react';
import type { CardVariant, PriceMode } from '../types';
import type { WantsItem, AvailableItem, VariantRestriction } from '../persistence';
import { formatPrice, getCardPrice } from '../services/priceService';
import { CardThumb } from './ui/CardThumb';
import { extractVariantLabel, extractBaseName, CANONICAL_VARIANTS, type CanonicalVariant } from '../variants';
import { VariantBadge } from './VariantBadge';
import { VariantSwapPopover } from './VariantSwapPopover';
import { VariantChip } from './VariantChip';
import { Popover } from './Popover';
import type { PopularWantsEntry } from '../hooks/usePopularWants';
import { NumberStepper } from './ui/NumberStepper';
import { useConfirmAction } from '../hooks/useConfirmAction';

function QtyStepper({ qty, onChangeQty }: { qty: number; onChangeQty: (n: number) => void }) {
  return (
    <NumberStepper
      value={qty}
      onChange={n => onChangeQty(n ?? 1)}
      min={1}
      max={99}
      ariaLabel="Quantity"
    />
  );
}

/**
 * Two-tap confirm-to-remove for per-row × buttons. State logic lives
 * in `useConfirmAction`; this component only owns the visual chrome
 * (idle: 24×24 ×-icon button, armed: amber pill with warning icon +
 * "Confirm?" label). `hit-area-44` extends the touch target invisibly
 * so the 24×24 visual never traps a fingertip.
 */
function RemoveButton({ onRemove }: { onRemove: () => void }) {
  const { armed, onClick, onBlur } = useConfirmAction(onRemove);
  return (
    <button
      type="button"
      aria-label={armed ? 'Tap again to confirm removal' : 'Remove'}
      aria-pressed={armed}
      title={armed ? 'Tap again to confirm' : 'Remove'}
      onClick={onClick}
      onBlur={onBlur}
      className={
        armed
          ? 'hit-area-44 shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded border border-crimson/60 bg-crimson/15 text-crimson-light text-[11px] font-semibold uppercase tracking-wide hover:bg-crimson/25 transition-colors'
          : 'hit-area-44 shrink-0 w-6 h-6 rounded text-gray-500 hover:text-crimson-light hover:bg-crimson/10 transition-colors flex items-center justify-center'
      }
    >
      {armed ? (
        <>
          <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 2.5l6 11H2L8 2.5z" />
            <path d="M8 7v3" />
            <path d="M8 11.5v0.01" />
          </svg>
          <span>Confirm?</span>
        </>
      ) : (
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 4L12 12M4 12L12 4" />
        </svg>
      )}
    </button>
  );
}

function RowShell({ productId, title, children }: { productId: string | undefined; title: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 rounded-lg bg-space-800/60 border border-space-700">
      <div className="w-10 h-14 shrink-0 rounded bg-space-900 overflow-hidden">
        <CardThumb productId={productId} name={title} size="md" className="w-full h-full" imgSize="sm" />
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">{children}</div>
    </li>
  );
}

// --- Wants -----------------------------------------------------------------

interface WantsRowProps {
  item: WantsItem;
  /** Any variant of this base card — used for image + display name. */
  sampleCard: CardVariant | null;
  /** Every printing of this card family in the dataset. The editor
   *  uses this to only offer variants that actually exist — a Pyke
   *  Sentinel never has a Prestige printing, so we don't show one. */
  familyCandidates: CardVariant[];
  /** True when this row's restriction editor is expanded. */
  isEditing: boolean;
  onChangeQty: (next: number) => void;
  onTogglePriority: () => void;
  onRemove: () => void;
  onToggleEdit: () => void;
  onChangeRestriction: (next: VariantRestriction) => void;
  /** Per-row matching-traders payload: count + capped user list of
   *  signed-in users whose public binder has a variant satisfying
   *  this want's restriction. Drives the "N has this" badge that
   *  opens a popover deep-linking to /u/<handle> for proposal.
   *  Mirrors the symmetric `wanters` prop on AvailableRow. */
  haves?: PopularWantsEntry;
}

function restrictionLabel(r: VariantRestriction): string {
  if (r.mode === 'any') return 'Any variant';
  if (r.variants.length === 1) return `Only ${r.variants[0]}`;
  if (r.variants.length === 2) return r.variants.join(' or ');
  return `${r.variants.length} variants`;
}

export function WantsRow({
  item,
  sampleCard,
  familyCandidates,
  isEditing,
  onChangeQty,
  onTogglePriority,
  onRemove,
  onToggleEdit,
  onChangeRestriction,
  haves,
}: WantsRowProps) {
  // Strip the variant suffix from the fallback name so unenriched cards
  // don't show "(Showcase)" in the title — variant is already conveyed
  // by the thumbnail art.
  const title = sampleCard?.displayName
    ?? (sampleCard?.name ? extractBaseName(sampleCard.name) : null)
    ?? item.familyId;

  return (
    <RowShell productId={sampleCard?.productId} title={title}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-100 leading-tight truncate">{title}</div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <button
              type="button"
              onClick={onToggleEdit}
              aria-expanded={isEditing}
              className="self-start flex items-center gap-1 px-2 py-1 rounded-md bg-space-900/70 border border-space-700 hover:border-gold/40 text-[11px] text-gray-300 hover:text-gold transition-colors"
            >
              <span className="truncate">{restrictionLabel(item.restriction)}</span>
              <ChevronIcon open={isEditing} className="w-3 h-3 shrink-0" />
            </button>
            {haves && haves.count > 0 && (
              <TraderMatchBadge match={haves} direction="haves" />
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label={item.isPriority ? 'Unmark as priority' : 'Mark as priority'}
          onClick={onTogglePriority}
          className="hit-area-44 shrink-0 w-6 h-6 rounded flex items-center justify-center transition-colors text-gray-600 hover:text-gold-bright"
        >
          <StarIcon filled={!!item.isPriority} className="w-4 h-4" />
        </button>
      </div>
      {isEditing && (
        <RestrictionEditor
          restriction={item.restriction}
          familyCandidates={familyCandidates}
          onChange={onChangeRestriction}
          onClose={onToggleEdit}
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <QtyStepper qty={item.qty} onChangeQty={onChangeQty} />
        <RemoveButton onRemove={onRemove} />
      </div>
    </RowShell>
  );
}

// --- Restriction editor ----------------------------------------------------

function RestrictionEditor({
  restriction,
  familyCandidates,
  onChange,
  onClose,
}: {
  restriction: VariantRestriction;
  familyCandidates: CardVariant[];
  onChange: (next: VariantRestriction) => void;
  onClose: () => void;
}) {
  const setMode = (mode: 'any' | 'restricted') => {
    if (mode === 'any') {
      onChange({ mode: 'any' });
    } else if (restriction.mode === 'any') {
      // Default "Specific" to just Standard — narrowest sensible starting
      // point. User can widen by tapping additional chips.
      onChange({ mode: 'restricted', variants: ['Standard'] });
    }
    // Already restricted — no-op.
  };

  const toggleVariant = (v: CanonicalVariant) => {
    if (restriction.mode === 'any') {
      // Coming from Any: selected variant becomes the sole entry.
      onChange({ mode: 'restricted', variants: [v] });
      return;
    }
    const selected = restriction.variants.includes(v);
    if (selected) {
      // Can't drop below one variant — schema requires min 1. Tapping the
      // last active chip is a no-op; flipping to Any requires the header
      // toggle.
      if (restriction.variants.length === 1) return;
      onChange({
        mode: 'restricted',
        variants: restriction.variants.filter(x => x !== v),
      });
    } else {
      onChange({
        mode: 'restricted',
        variants: [...restriction.variants, v],
      });
    }
  };

  return (
    <div className="relative rounded-lg bg-space-900/70 border border-space-700 px-3 pt-2 pb-3 pr-9">
      <button
        type="button"
        aria-label="Close variant editor"
        onClick={onClose}
        className="hit-area-44 absolute top-1.5 right-1.5 w-6 h-6 rounded text-gray-500 hover:text-gray-200 hover:bg-space-700 transition-colors flex items-center justify-center"
      >
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 4L12 12M4 12L12 4" />
        </svg>
      </button>
      <div className="flex items-center gap-1 mb-2">
        <SegmentedOption active={restriction.mode === 'any'} onClick={() => setMode('any')}>
          Any
        </SegmentedOption>
        <SegmentedOption
          active={restriction.mode === 'restricted'}
          onClick={() => setMode('restricted')}
        >
          Specific
        </SegmentedOption>
      </div>
      {restriction.mode === 'restricted' && (() => {
        // Only surface variants that actually exist for this card
        // family (a Pyke Sentinel has no Prestige / Serialized /
        // Showcase printing, so those chips would be misleading).
        // A variant already locked in the saved restriction stays
        // visible even if the dataset doesn't know about it, so the
        // user can still deselect stale state. Re-skinned 2026-05-20
        // to share <VariantChip> with the new VariantSwapPopover so
        // the two surfaces' chip visual stays in lockstep.
        const existing = new Set(familyCandidates.map(c => extractVariantLabel(c.name)));
        const relevant = CANONICAL_VARIANTS.filter(
          v => existing.has(v) || (restriction.mode === 'restricted' && restriction.variants.includes(v)),
        );
        return (
          <div className="flex flex-wrap gap-1">
            {relevant.map(v => (
              <VariantChip
                key={v}
                variant={v}
                selected={restriction.variants.includes(v)}
                onClick={() => toggleVariant(v)}
                size="md"
              />
            ))}
          </div>
        );
      })()}
    </div>
  );
}

function SegmentedOption({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 rounded-md text-xs font-semibold transition-colors ${
        active ? 'bg-gold/20 text-gold' : 'text-gray-400 hover:text-gray-200'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Variant pill used inside the swap popover trigger. Renders the
 * existing VariantBadge for non-Standard variants; for Standard,
 * which VariantBadge intentionally skips, falls back to a small
 * grey "Standard" pill. Standard rows still need a clickable
 * anchor — otherwise swap is undiscoverable on the most common
 * row shape. The grey tone keeps the chrome quiet for the
 * implicit-baseline case.
 */
function VariantPillForSwap({ variant }: { variant: string }) {
  if (variant && variant !== 'Standard') {
    return <VariantBadge variant={variant} size="xs" />;
  }
  return (
    <span className="text-[8px] tracking-wide uppercase font-bold px-1 py-0.5 rounded bg-space-800 text-gray-400 border border-space-700">
      Standard
    </span>
  );
}

// --- Available -------------------------------------------------------------

interface AvailableRowProps {
  item: AvailableItem;
  card: CardVariant | null;
  /** Accepted but ignored — binder row prices always show raw 100%
   *  TCGPlayer (mkt/low) so they cross-reference cleanly. The trade
   *  balancer is the only surface that applies the user's percentage
   *  modifier; lists / pickers / profile views are all reference
   *  surfaces, not negotiation surfaces. */
  percentage?: number;
  priceMode: PriceMode;
  /** Per-row wanters payload: count of distinct other users whose
   *  restriction would accept this exact binder variant, plus a
   *  capped list of surfaceable identities (handle/avatar) for the
   *  user-picker popover the badge opens. The 2026-05-20 rewrite
   *  replaced the old family-id-only count with this variant-aware
   *  shape — see api/popular-wants.ts. */
  wanters?: PopularWantsEntry;
  /** Takes (id, next-qty) so the parent can pass a stable reference
   *  (the hook's `useCallback`'d update method) and let the row close
   *  over its own item.id. Replaces the older `(next) => void` shape
   *  whose inline arrow at the call site defeated React.memo. */
  onChangeQty: (id: string, nextQty: number) => void;
  onRemove: (id: string) => void;
  /** Every CardVariant in this row's family — drives the variant-
   *  swap popover anchored to the variant pill. When undefined or
   *  empty the pill renders as the existing read-only badge. */
  familyCandidates?: readonly CardVariant[];
  /** Called when the user picks a different print variant via the
   *  swap popover. The new CardVariant's productId becomes the
   *  row's productId; the parent's `available.update` merges qty
   *  if that productId already has a row. */
  onSwapVariant?: (id: string, newCard: CardVariant) => void;
}

export const AvailableRow = memo(function AvailableRow({
  item,
  card,
  priceMode,
  wanters,
  onChangeQty,
  onRemove,
  familyCandidates,
  onSwapVariant,
}: AvailableRowProps) {
  const title = card?.displayName ?? card?.name ?? item.productId;
  const variant = card ? extractVariantLabel(card.name) : 'Standard';
  const price = card ? getCardPrice(card, priceMode) : null;
  const wantCount = wanters?.count ?? 0;
  const showWantBadge = wantCount > 0;
  // Swap is enabled only when the parent supplied both the family
  // candidates (catalog data to populate the popover) and a handler
  // (state mutation path). With only one variant in the family the
  // popover would be a no-op — skip the trigger entirely so we don't
  // dangle an interactive affordance that does nothing.
  const swapEnabled =
    !!card
    && !!onSwapVariant
    && !!familyCandidates
    && familyCandidates.length > 1;

  return (
    <RowShell productId={card?.productId} title={title}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-100 leading-tight truncate">{title}</div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {swapEnabled ? (
              <VariantSwapPopover
                currentCard={card!}
                familyCandidates={familyCandidates!}
                onSelect={next => onSwapVariant!(item.id, next)}
              >
                <VariantPillForSwap variant={variant} />
              </VariantSwapPopover>
            ) : (
              <VariantBadge variant={variant} size="xs" />
            )}
            {price !== null && (
              <span className="text-[10px] text-gold font-semibold">{formatPrice(price)}</span>
            )}
            {showWantBadge && wanters && (
              <TraderMatchBadge match={wanters} direction="wants" />
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <QtyStepper qty={item.qty} onChangeQty={n => onChangeQty(item.id, n)} />
        <RemoveButton onRemove={() => onRemove(item.id)} />
      </div>
    </RowShell>
  );
});

// --- Icons -----------------------------------------------------------------

function ChevronIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${className} transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function StarIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden
      style={filled ? { color: 'var(--color-gold-bright)' } : undefined}
    >
      <path d="M8 1.5l2 4.5 5 .5-3.75 3.25L12.5 15 8 12.25 3.5 15l1.25-5.25L1 6.5 6 6z" />
    </svg>
  );
}

/**
 * Clickable trader-match badge — surfaces on binder rows ("N wants
 * this") and wishlist rows ("N has this"). Tapping opens a popover
 * with up to 10 trader identities, each linking to `/u/<handle>` so
 * the viewer can browse a profile and propose a trade.
 *
 * Direction-aware labels:
 *   - `wants` (binder row): "N wants this" / "N traders want this"
 *   - `haves` (wishlist row): "N has this" / "N traders have this"
 *
 * Privacy convention enforced server-side: traders whose
 * profileVisibility is `private` are excluded from the surfaced
 * user list (opt-out of discovery) but their want / available row
 * still contributes to the count. When `count > users.length`
 * (capped at 10 by the API) the popover shows "and N more" so the
 * statistical signal stays honest.
 */
function TraderMatchBadge({
  match,
  direction,
}: {
  match: PopularWantsEntry;
  direction: 'wants' | 'haves';
}) {
  const { count, users } = match;
  const overflow = count - users.length;
  const triggerText = direction === 'wants'
    ? `${count} want${count === 1 ? 's' : ''} this`
    : `${count} ha${count === 1 ? 's' : 've'} this`;
  const headerText = direction === 'wants'
    ? (count === 1 ? '1 trader wants this' : `${count} traders want this`)
    : (count === 1 ? '1 trader has this' : `${count} traders have this`);
  const ariaLabel = direction === 'wants'
    ? `${count} other user${count === 1 ? '' : 's'} want this on their public list — tap to view`
    : `${count} other user${count === 1 ? '' : 's'} ${count === 1 ? 'has' : 'have'} this on their public binder — tap to view`;
  const emptyCopy = direction === 'wants'
    ? 'No public profiles to show — all wanters have private profiles.'
    : 'No public profiles to show — all owners have private profiles.';
  // Color tone follows the trade-side palette: wants direction
  // (someone wants something the viewer has) gets blue (= receiving
  // for the viewer); haves direction (someone has something the
  // viewer wants) gets emerald (= offering FOR the viewer).
  const triggerClass = direction === 'wants'
    ? 'bg-blue-500/15 border-blue-500/30 text-blue-200 hover:bg-blue-500/25 hover:border-blue-500/50'
    : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/25 hover:border-emerald-500/50';
  return (
    <Popover
      align="center"
      panelClassName="p-2 min-w-[220px]"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={ariaLabel}
          className={`text-[10px] font-semibold px-1.5 py-px rounded-full border transition-colors cursor-pointer ${triggerClass}`}
        >
          {triggerText}
        </button>
      )}
    >
      {() => (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] tracking-[0.1em] uppercase font-bold text-gray-500 px-2 pt-1 pb-0.5">
            {headerText}
          </span>
          {users.length === 0 ? (
            <span className="text-[11px] text-gray-400 italic px-2 py-1">{emptyCopy}</span>
          ) : (
            <ul className="flex flex-col">
              {users.map(u => (
                <li key={u.handle}>
                  <a
                    href={`/u/${encodeURIComponent(u.handle)}`}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-space-700 transition-colors"
                  >
                    {u.avatarUrl ? (
                      <img
                        src={u.avatarUrl}
                        alt=""
                        className="w-6 h-6 rounded-full border border-space-700 shrink-0"
                      />
                    ) : (
                      <span className="w-6 h-6 rounded-full bg-space-700 border border-space-600 text-[10px] text-gray-400 flex items-center justify-center shrink-0">
                        {u.handle.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="flex flex-col min-w-0">
                      <span className="text-xs text-gray-100 font-medium truncate">
                        @{u.handle}
                      </span>
                      {u.username && u.username !== u.handle && (
                        <span className="text-[10px] text-gray-500 truncate">{u.username}</span>
                      )}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {overflow > 0 && (
            <span className="text-[10px] text-gray-500 italic px-2 pb-1">
              and {overflow} more
            </span>
          )}
        </div>
      )}
    </Popover>
  );
}
