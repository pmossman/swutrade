import type { CardVariant, TradeCard, PriceMode } from '../types';
import { tradeCardKey } from '../types';
import type { SetSearchGroup } from '../hooks/useCardSearch';
import { CardTile } from './CardTile';
import type { SearchScope } from '../hooks/useVariantFilter';
import { CardResultsGrid } from './CardResultsGrid';

interface SearchResultsProps {
  results: SetSearchGroup[];
  percentage: number;
  priceMode: PriceMode;
  onAdd: (card: CardVariant) => void;
  onChangeQty: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  tradeCards: TradeCard[];
  isSearching: boolean;
  query: string;
  accentColor: 'emerald' | 'blue';
  scope: SearchScope;
  hiddenVariants: Set<string>;
  hiddenSets: Set<string>;
}

// Trade-side wrapper around CardResultsGrid. Renders each variant as a
// qty-aware CardTile.
export function SearchResults({
  results,
  percentage,
  priceMode,
  onAdd,
  onChangeQty,
  onRemove,
  tradeCards,
  isSearching,
  query,
  accentColor,
  scope,
  hiddenVariants,
  hiddenSets,
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
      query={query}
      isSearching={isSearching}
      scope={scope}
      hiddenVariants={hiddenVariants}
      hiddenSets={hiddenSets}
      renderTile={(card, ctx) => {
        const key = tradeCardKey(card);
        const qty = tradeCards.find(tc => tradeCardKey(tc.card) === key)?.qty ?? 0;
        return (
          <CardTile
            key={`${card.name}-${card.set}`}
            card={card}
            qty={qty}
            percentage={percentage}
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
