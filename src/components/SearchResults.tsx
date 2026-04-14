import type { CardVariant, TradeCard, PriceMode } from '../types';
import { SETS, tradeCardKey } from '../types';
import type { SetSearchGroup } from '../hooks/useCardSearch';
import { CardTile } from './CardTile';
import { variantRank, extractVariantLabel, isLeaderOrBaseGroup } from '../variants';
import type { SearchScope } from '../hooks/useVariantFilter';

const promoSlugs = new Set(SETS.filter(s => s.category === 'promo').map(s => s.slug));

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
  // Persisted filter state (owned by TradeSide)
  scope: SearchScope;
  hiddenVariants: Set<string>;
  hiddenSets: Set<string>;
}

// Pure result renderer — controls live in SearchControls above the
// scroll area. Only sticky element here is the set-group header.
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

  if (!query || query.length < 2) return null;

  if (isSearching) {
    return (
      <div className="bg-space-800 border border-space-600 rounded-lg mt-1 p-6 text-center text-gray-500 text-sm">
        Searching...
      </div>
    );
  }

  const hasResults = results.some(sg => sg.groups.length > 0);

  if (!hasResults) {
    return (
      <div className="bg-space-800 border border-space-600 rounded-lg mt-1 p-6 text-center">
        <div className="text-gray-500 text-sm">No cards found</div>
      </div>
    );
  }

  // Scope filter (main/promo/all) first, then user's hide-set filter,
  // then per-variant hide.
  const scopedResults = results.filter(sg => {
    if (scope === 'main') return !promoSlugs.has(sg.setSlug);
    if (scope === 'promo') return promoSlugs.has(sg.setSlug);
    return true;
  });

  const filteredResults = (hiddenVariants.size === 0 && hiddenSets.size === 0)
    ? scopedResults
    : scopedResults
      .filter(sg => !hiddenSets.has(sg.setSlug))
      .map(sg => ({
        ...sg,
        groups: sg.groups
          .map(g => ({
            ...g,
            variants: g.variants.filter(c => !hiddenVariants.has(extractVariantLabel(c.name))),
          }))
          .filter(g => g.variants.length > 0),
      }))
      .filter(sg => sg.groups.length > 0);

  if (filteredResults.length === 0) {
    return (
      <div className="bg-space-800 border border-space-700 rounded-lg mt-1 p-6 text-center">
        <div className="text-gray-500 text-sm">
          Everything matching "{query}" is hidden by your current filters.
        </div>
      </div>
    );
  }

  const showSetHeaders = filteredResults.length > 1;

  return (
    <div className="space-y-8">
      {filteredResults.map(setGroup => (
        <section key={setGroup.setSlug}>
          {showSetHeaders && (
            <div className="flex items-baseline gap-2 px-2 py-2 sticky -top-px bg-space-900 z-10 mb-4 border-b border-space-700 shadow-[0_8px_12px_-8px_rgba(0,0,0,0.8)]">
              <span className="text-[11px] font-bold text-gray-300 uppercase tracking-widest">
                {setGroup.setCode}
              </span>
              <span className="text-[10px] text-gray-600">{setGroup.setName}</span>
            </div>
          )}
          <div className="space-y-6">
            {setGroup.groups.map(group => {
              const leaderGroup = isLeaderOrBaseGroup(group.variants);
              const gridCols = leaderGroup
                ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
                : 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7';
              return (
                <div key={`${setGroup.setSlug}-${group.baseName}`}>
                  <div className="px-1 pb-2 text-xs font-medium text-gray-300 truncate">
                    {group.baseName}
                  </div>
                  <div className={`grid ${gridCols} gap-3`}>
                    {[...group.variants]
                      .sort((a, b) => variantRank(extractVariantLabel(a.name)) - variantRank(extractVariantLabel(b.name)))
                      .map((card, i) => {
                        const key = tradeCardKey(card);
                        const qty = tradeCards.find(tc => tradeCardKey(tc.card) === key)?.qty ?? 0;
                        return (
                          <CardTile
                            key={`${card.name}-${card.set}-${i}`}
                            card={card}
                            qty={qty}
                            percentage={percentage}
                            priceMode={priceMode}
                            accentColor={accentColor}
                            onAdd={onAdd}
                            onDecrement={handleDecrement}
                            landscape={leaderGroup}
                          />
                        );
                      })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

    </div>
  );
}
