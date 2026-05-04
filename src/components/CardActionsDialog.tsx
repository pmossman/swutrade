import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import type { CardVariant } from '../types';
import { extractVariantLabel, variantBadgeColor, variantDisplayLabel } from '../variants';
import { adjustPrice, cardImageUrl, formatPrice, getCardPrice } from '../services/priceService';

interface CardActionsDialogProps {
  /** Card the user tapped from the browser. `null` keeps the dialog
   *  closed; setting it opens with that card. */
  card: CardVariant | null;
  onClose: () => void;
  onAddToWishlist: (card: CardVariant) => void;
  onAddToBinder: (card: CardVariant) => void;
  onStartTrade: (card: CardVariant) => void;
}

/**
 * "Where to?" dialog opened from a card-browser tile. Three peer
 * destinations: wishlist (multi-device synced), binder (per-printing),
 * trade (seeds the composer). Browser is a discovery surface; this
 * dialog is the pivot into the existing list/trade flows.
 *
 * Each action confirms in-place with a brief 1.5s toast-style state
 * before closing — gives the user the "yes, that landed" feedback
 * they'd otherwise have to navigate to verify. After the toast the
 * dialog auto-closes so they can keep browsing.
 */
export function CardActionsDialog({
  card,
  onClose,
  onAddToWishlist,
  onAddToBinder,
  onStartTrade,
}: CardActionsDialogProps) {
  const open = card !== null;
  const [confirmation, setConfirmation] = useState<string | null>(null);

  // Reset confirmation when the dialog re-opens for a fresh card so
  // the user doesn't see "Added to wishlist" linger from a previous
  // tap.
  useEffect(() => {
    if (open) setConfirmation(null);
  }, [open, card?.productId]);

  const handle = (label: string, fn: () => void) => () => {
    fn();
    setConfirmation(label);
    setTimeout(() => onClose(), 1200);
  };

  if (!card) return null;

  const variant = extractVariantLabel(card.name);
  const variantLabel = variantDisplayLabel(variant) || variant;
  const baseName = card.name.replace(/\s*\([^)]*\)\s*$/, '');
  const market = adjustPrice(getCardPrice(card, 'market'), 100);
  const low = adjustPrice(getCardPrice(card, 'low'), 100);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm rounded-xl bg-space-900 border border-space-700 p-4 shadow-xl"
        >
          <Dialog.Title className="text-[11px] tracking-[0.18em] uppercase font-bold text-gray-500 mb-3">
            Add this card to…
          </Dialog.Title>

          {/* Card identity strip — small thumb + name + variant + prices,
              so the destination buttons feel anchored to a specific
              card rather than a free-floating action menu. */}
          <div className="flex items-start gap-3 pb-3 mb-3 border-b border-space-800">
            {cardImageUrl(card.productId) && (
              <img
                src={cardImageUrl(card.productId) ?? ''}
                alt=""
                className="w-12 h-auto rounded-sm border border-space-700"
                loading="lazy"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-gray-100 truncate">{baseName}</div>
              <div className="flex items-center gap-1.5 mt-1">
                <span
                  className={`text-[9px] leading-none px-1.5 py-0.5 rounded font-bold uppercase tracking-wide ${variantBadgeColor(variant)}`}
                >
                  {variantLabel}
                </span>
                <span className="text-[10px] text-gray-500">{card.set?.toUpperCase()}</span>
              </div>
              <div className="text-[10px] text-gray-400 tabular-nums mt-1.5">
                {low !== null && <>Low <span className="text-gold font-semibold">{formatPrice(low)}</span></>}
                {low !== null && market !== null && <span className="text-gray-600 mx-1">·</span>}
                {market !== null && <>Mkt <span className="text-gray-300">{formatPrice(market)}</span></>}
              </div>
            </div>
          </div>

          {confirmation ? (
            <div
              role="status"
              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 text-xs font-semibold px-3 py-2 text-center"
            >
              {confirmation}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <DestinationButton
                label="Add to wishlist"
                hint="Pinned to this exact variant"
                onClick={handle('Added to wishlist', () => onAddToWishlist(card))}
              />
              <DestinationButton
                label="Add to binder"
                hint="Marks this printing as something you have"
                onClick={handle('Added to binder', () => onAddToBinder(card))}
              />
              <DestinationButton
                label="Start a trade with this card"
                hint="Opens the trade builder with this card on your side"
                onClick={handle('Opening trade builder…', () => onStartTrade(card))}
              />
            </div>
          )}

          {!confirmation && (
            <Dialog.Close asChild>
              <button
                type="button"
                className="mt-3 w-full text-[11px] text-gray-500 hover:text-gray-300 transition-colors py-1"
              >
                Cancel
              </button>
            </Dialog.Close>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DestinationButton({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-md border border-space-700 bg-space-800/40 hover:border-gold/50 hover:bg-gold/10 text-left transition-colors"
    >
      <span className="text-xs font-semibold text-gray-100">{label}</span>
      <span className="text-[10px] text-gray-500 leading-tight">{hint}</span>
    </button>
  );
}
