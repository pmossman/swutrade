import { useRef, useEffect } from 'react';
import type { CardVariant } from '../types';
import { useCardSearch } from '../hooks/useCardSearch';
import {
  cardImageUrl,
  adjustPrice,
  getCardPrice,
} from '../services/priceService';
import { extractVariantLabel, variantBadgeColor, variantDisplayLabel } from '../variants';
import type { PriceMode } from '../types';

interface ListCardPickerProps {
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
  title: string;            // e.g. "Add to Wants"
  onPick: (card: CardVariant) => void;
  onClose: () => void;
}

export function ListCardPicker({
  allCards,
  percentage,
  priceMode,
  title,
  onPick,
  onClose,
}: ListCardPickerProps) {
  const { query, setQuery, results, isSearching } = useCardSearch({
    allCards,
    setFilter: null,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const flatCards: CardVariant[] = results.flatMap(set => set.groups.flatMap(g => g.variants));

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-space-800">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="shrink-0 text-gray-500 hover:text-gray-200 transition-colors"
        >
          <BackIcon className="w-4 h-4" />
        </button>
        <span className="text-[11px] font-bold tracking-[0.1em] uppercase text-gray-400">
          {title}
        </span>
      </div>

      <div className="px-3 pt-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search cards..."
          className="w-full px-3 py-2 rounded-lg bg-space-800 border border-space-700 focus:border-gold/50 focus:outline-none text-sm text-gray-100 placeholder:text-gray-600"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {query.trim().length < 2 ? (
          <div className="py-10 text-center text-xs text-gray-500">
            Type a card name to search
          </div>
        ) : isSearching ? (
          <div className="py-10 text-center text-xs text-gray-500 animate-pulse">
            Searching…
          </div>
        ) : flatCards.length === 0 ? (
          <div className="py-10 text-center text-xs text-gray-500">
            No matches
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {flatCards.map(card => (
              <PickerTile
                key={`${card.set}-${card.productId ?? card.name}`}
                card={card}
                percentage={percentage}
                priceMode={priceMode}
                onPick={() => onPick(card)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface PickerTileProps {
  card: CardVariant;
  percentage: number;
  priceMode: PriceMode;
  onPick: () => void;
}

function PickerTile({ card, percentage, priceMode, onPick }: PickerTileProps) {
  const variant = extractVariantLabel(card.name);
  const variantLabel = variantDisplayLabel(variant);
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');

  return (
    <button
      type="button"
      onClick={onPick}
      className="group flex flex-col items-stretch rounded-lg bg-space-800/80 border border-space-700 hover:border-gold/40 active:scale-[0.98] transition-all text-left overflow-hidden"
    >
      <div className="aspect-[5/7] bg-space-900 overflow-hidden">
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={card.name}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : null}
      </div>
      <div className="px-2 py-1.5 flex flex-col gap-0.5">
        <div className="text-[11px] leading-tight text-gray-200 line-clamp-2">
          {card.displayName ?? card.name}
        </div>
        <div className="flex items-center gap-1">
          {variantLabel && (
            <span className={`text-[8px] leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide ${variantBadgeColor(variant)}`}>
              {variantLabel}
            </span>
          )}
          {price !== null && (
            <span className="ml-auto text-[10px] text-gold font-semibold">
              ${price.toFixed(2)}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function BackIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 12L6 8L10 4" />
    </svg>
  );
}
