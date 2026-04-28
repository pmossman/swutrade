import type { CardVariant, TradeCard, PriceMode } from '../types';
import { tradeCardKey } from '../types';
import type { SetSearchGroup } from '../hooks/useCardSearch';
import { CardTile } from './CardTile';
import { CardResultsGrid } from './CardResultsGrid';

interface SearchResultsProps {
  results: SetSearchGroup[];
  priceMode: PriceMode;
  onAdd: (card: CardVariant) => void;
  onChangeQty: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  tradeCards: TradeCard[];
  isSearching: boolean;
  accentColor: 'emerald' | 'blue';
}

// Trade-side wrapper around CardResultsGrid. Renders each variant as a
// qty-aware CardTile.
//
// Picker tile prices are pinned at 100% (raw TCGPlayer market/low) —
// the user's percentage modifier (default 80%) only applies inside
// the actual trade balancer. The mismatch was confusing: shopping
// for cards at 80% adjusted prices made it hard to cross-reference
// against TCGPlayer, which is the canonical source. The trade view
// (TradeRow / TradeSide) and the trade-builder running totals still
// use the user's percentage, so the eventual values they trade at
// reflect their setting.
const PICKER_PERCENTAGE = 100;

export function SearchResults({
  results,
  priceMode,
  onAdd,
  onChangeQty,
  onRemove,
  tradeCards,
  isSearching,
  accentColor,
}: SearchResultsProps) {
  const handleDecrement = (card: CardVariant) => {
    const key = tradeCardKey(card);
    const tc = tradeCards.find(c => tradeCardKey(c.card) === key);
    if (!tc) return;
    if (tc.qty <= 1) onRemove(key);
    else onChangeQty(key, -1);
  };

  return (
    <CardResultsGrid
      results={results}
      isSearching={isSearching}
      renderTile={(card, ctx) => {
        const key = tradeCardKey(card);
        const qty = tradeCards.find(tc => tradeCardKey(tc.card) === key)?.qty ?? 0;
        return (
          <CardTile
            key={`${card.name}-${card.set}`}
            card={card}
            qty={qty}
            percentage={PICKER_PERCENTAGE}
            priceMode={priceMode}
            accentColor={accentColor}
            onAdd={onAdd}
            onDecrement={handleDecrement}
            landscape={ctx.leaderGroup}
          />
        );
      }}
    />
  );
}
