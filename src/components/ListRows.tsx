import type { CardVariant, PriceMode } from '../types';
import type { WantsItem, AvailableItem, VariantRestriction } from '../persistence';
import { cardImageUrl, adjustPrice, getCardPrice } from '../services/priceService';
import { variantBadgeColor, variantChipLabel, extractVariantLabel, extractBaseName, CANONICAL_VARIANTS, type CanonicalVariant } from '../variants';
import { VariantBadge } from './VariantBadge';

function QtyStepper({ qty, onChangeQty }: { qty: number; onChangeQty: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button
        type="button"
        aria-label="Decrease quantity"
        onClick={() => onChangeQty(Math.max(1, qty - 1))}
        className="w-6 h-6 rounded bg-space-800 border border-space-700 text-gray-400 hover:text-gold hover:border-gold/40 transition-colors flex items-center justify-center"
      >
        −
      </button>
      <span className="w-6 text-center text-sm font-bold text-gray-200">{qty}</span>
      <button
        type="button"
        aria-label="Increase quantity"
        onClick={() => onChangeQty(Math.min(99, qty + 1))}
        className="w-6 h-6 rounded bg-space-800 border border-space-700 text-gray-400 hover:text-gold hover:border-gold/40 transition-colors flex items-center justify-center"
      >
        +
      </button>
    </div>
  );
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label="Remove"
      onClick={onRemove}
      className="shrink-0 w-6 h-6 rounded text-gray-500 hover:text-crimson-light hover:bg-crimson/10 transition-colors flex items-center justify-center"
    >
      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M4 4L12 12M4 12L12 4" />
      </svg>
    </button>
  );
}

function RowShell({ imgUrl, title, children }: { imgUrl: string | null; title: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 rounded-lg bg-space-800/60 border border-space-700">
      <div className="w-10 h-14 shrink-0 rounded bg-space-900 overflow-hidden">
        {imgUrl ? <img src={imgUrl} alt={title} loading="lazy" className="w-full h-full object-cover" /> : null}
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
}: WantsRowProps) {
  const imgUrl = sampleCard?.productId ? cardImageUrl(sampleCard.productId, 'sm') : null;
  // Strip the variant suffix from the fallback name so unenriched cards
  // don't show "(Showcase)" in the title — variant is already conveyed
  // by the thumbnail art.
  const title = sampleCard?.displayName
    ?? (sampleCard?.name ? extractBaseName(sampleCard.name) : null)
    ?? item.familyId;

  return (
    <RowShell imgUrl={imgUrl} title={title}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-100 leading-tight truncate">{title}</div>
          <button
            type="button"
            onClick={onToggleEdit}
            aria-expanded={isEditing}
            className="self-start flex items-center gap-1 mt-1 px-2 py-1 rounded-md bg-space-900/70 border border-space-700 hover:border-gold/40 text-[11px] text-gray-300 hover:text-gold transition-colors"
          >
            <span className="truncate">{restrictionLabel(item.restriction)}</span>
            <ChevronIcon open={isEditing} className="w-3 h-3 shrink-0" />
          </button>
        </div>
        <button
          type="button"
          aria-label={item.isPriority ? 'Unmark as priority' : 'Mark as priority'}
          onClick={onTogglePriority}
          className="shrink-0 w-6 h-6 rounded flex items-center justify-center transition-colors text-gray-600 hover:text-gold-bright"
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
        className="absolute top-1.5 right-1.5 w-6 h-6 rounded text-gray-500 hover:text-gray-200 hover:bg-space-700 transition-colors flex items-center justify-center"
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
        // user can still deselect stale state.
        const existing = new Set(familyCandidates.map(c => extractVariantLabel(c.name)));
        const relevant = CANONICAL_VARIANTS.filter(
          v => existing.has(v) || (restriction.mode === 'restricted' && restriction.variants.includes(v)),
        );
        return (
          <div className="flex flex-wrap gap-1">
            {relevant.map(v => {
              const selected = restriction.variants.includes(v);
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => toggleVariant(v)}
                  className={`text-xs leading-none px-3 py-2 rounded font-medium transition-opacity ${variantBadgeColor(v)} ${selected ? '' : 'opacity-30'}`}
                  aria-pressed={selected}
                >
                  {variantChipLabel(v)}
                </button>
              );
            })}
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

// --- Available -------------------------------------------------------------

interface AvailableRowProps {
  item: AvailableItem;
  card: CardVariant | null;
  percentage: number;
  priceMode: PriceMode;
  onChangeQty: (next: number) => void;
  onRemove: () => void;
}

export function AvailableRow({
  item,
  card,
  percentage,
  priceMode,
  onChangeQty,
  onRemove,
}: AvailableRowProps) {
  const imgUrl = card?.productId ? cardImageUrl(card.productId, 'sm') : null;
  const title = card?.displayName ?? card?.name ?? item.productId;
  const variant = card ? extractVariantLabel(card.name) : 'Standard';
  const price = card ? adjustPrice(getCardPrice(card, priceMode), percentage) : null;

  return (
    <RowShell imgUrl={imgUrl} title={title}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-100 leading-tight truncate">{title}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <VariantBadge variant={variant} size="xs" />
            {price !== null && (
              <span className="text-[10px] text-gold font-semibold">${price.toFixed(2)}</span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <QtyStepper qty={item.qty} onChangeQty={onChangeQty} />
        <RemoveButton onRemove={onRemove} />
      </div>
    </RowShell>
  );
}

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
