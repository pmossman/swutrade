import type { CardVariant, PriceMode } from '../types';
import type { WantsItem, AvailableItem } from '../persistence';
import { cardImageUrl, adjustPrice, getCardPrice } from '../services/priceService';
import { variantBadgeColor, variantDisplayLabel, extractVariantLabel } from '../variants';

interface SharedChromeProps {
  imgUrl: string | null;
  title: string;
  qty: number;
  onChangeQty: (next: number) => void;
  onRemove: () => void;
}

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

function RowShell({ imgUrl, title, children }: SharedChromeProps & { children: React.ReactNode }) {
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
  onChangeQty: (next: number) => void;
  onTogglePriority: () => void;
  onRemove: () => void;
}

export function WantsRow({ item, sampleCard, onChangeQty, onTogglePriority, onRemove }: WantsRowProps) {
  const imgUrl = sampleCard?.productId ? cardImageUrl(sampleCard.productId, 'sm') : null;
  const title = sampleCard?.displayName ?? sampleCard?.name ?? item.baseCardId;
  const restriction = item.restriction.mode === 'any'
    ? 'Any variant'
    : item.restriction.variants.length === 1
      ? item.restriction.variants[0]
      : `${item.restriction.variants.length} variants`;

  return (
    <RowShell imgUrl={imgUrl} title={title} qty={item.qty} onChangeQty={onChangeQty} onRemove={onRemove}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-100 leading-tight truncate">{title}</div>
          <div className="text-[10px] text-gray-500 mt-0.5 truncate">{restriction}</div>
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
      <div className="flex items-center justify-between">
        <QtyStepper qty={item.qty} onChangeQty={onChangeQty} />
        <RemoveButton onRemove={onRemove} />
      </div>
    </RowShell>
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

export function AvailableRow({ item, card, percentage, priceMode, onChangeQty, onRemove }: AvailableRowProps) {
  const imgUrl = card?.productId ? cardImageUrl(card.productId, 'sm') : null;
  const title = card?.displayName ?? card?.name ?? item.productId;
  const variant = card ? extractVariantLabel(card.name) : 'Standard';
  const variantLabel = variantDisplayLabel(variant);
  const price = card ? adjustPrice(getCardPrice(card, priceMode), percentage) : null;

  return (
    <RowShell imgUrl={imgUrl} title={title} qty={item.qty} onChangeQty={onChangeQty} onRemove={onRemove}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-100 leading-tight truncate">{title}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {variantLabel && (
              <span className={`text-[8px] leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide ${variantBadgeColor(variant)}`}>
                {variantLabel}
              </span>
            )}
            {price !== null && (
              <span className="text-[10px] text-gold font-semibold">${price.toFixed(2)}</span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <QtyStepper qty={item.qty} onChangeQty={onChangeQty} />
        <RemoveButton onRemove={onRemove} />
      </div>
    </RowShell>
  );
}

// --- Icons -----------------------------------------------------------------

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
