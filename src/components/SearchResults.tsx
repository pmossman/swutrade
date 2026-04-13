import { useState } from 'react';
import type { CardVariant, TradeCard, PriceMode } from '../types';
import { SETS, tradeCardKey } from '../types';
import type { SetSearchGroup } from '../hooks/useCardSearch';
import { adjustPrice, extractVariantLabel, cardImageUrl, cardTcgPlayerUrl, getCardPrice, getAltPrice } from '../services/priceService';

const promoSlugs = new Set(SETS.filter(s => s.category === 'promo').map(s => s.slug));

type ResultTab = 'main' | 'promo';

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
  accentColor: string;
  isExpanded: boolean;
  setFilterLabel: string | null;
  onExpandSearch: () => void;
}

function formatPrice(price: number | null): string {
  if (price === null) return 'N/A';
  return `$${price.toFixed(2)}`;
}

function variantBadgeColor(variant: string): string {
  switch (variant) {
    case 'Standard': return 'bg-gray-600/50 text-gray-300';
    case 'Hyperspace': return 'bg-blue-900/50 text-blue-300';
    case 'Hyperspace Foil': return 'bg-purple-900/50 text-purple-300';
    case 'Showcase': return 'bg-amber-900/50 text-amber-300';
    default: return 'bg-space-600 text-gray-300';
  }
}

function CardImage({ productId, name }: { productId?: string; name: string }) {
  const [errored, setErrored] = useState(false);
  const src = cardImageUrl(productId);

  if (!src || errored) {
    return (
      <div className="w-9 h-[50px] rounded bg-space-600 shrink-0 flex items-center justify-center text-gray-600 text-[10px]">
        ?
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      onError={() => setErrored(true)}
      className="w-9 h-[50px] rounded object-cover shrink-0 bg-space-600"
    />
  );
}

const addBtnClass: Record<string, string> = {
  emerald: 'bg-emerald-900/50 text-emerald-400 hover:bg-emerald-800/60 active:bg-emerald-800/80',
  blue: 'bg-blue-900/50 text-blue-400 hover:bg-blue-800/60 active:bg-blue-800/80',
};

const qtyBtnColors: Record<string, string> = {
  emerald: 'text-emerald-400 bg-emerald-900/30 hover:bg-emerald-900/50 active:bg-emerald-900/70',
  blue: 'text-blue-400 bg-blue-900/30 hover:bg-blue-900/50 active:bg-blue-900/70',
};

function QtyControls({ card, qty, onAdd, onChangeQty, onRemove, accentColor }: {
  card: CardVariant;
  qty: number;
  onAdd: (c: CardVariant) => void;
  onChangeQty: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  accentColor: string;
}) {
  const btnClass = addBtnClass[accentColor] || addBtnClass.emerald;
  const qtyBtn = qtyBtnColors[accentColor] || qtyBtnColors.emerald;
  const key = tradeCardKey(card);

  if (qty === 0) {
    return (
      <button
        onClick={() => onAdd(card)}
        className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-lg font-bold transition-all active:scale-90 ${btnClass}`}
        aria-label={`Add ${card.name}`}
      >
        +
      </button>
    );
  }

  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <button
        onClick={() => qty <= 1 ? onRemove(key) : onChangeQty(key, -1)}
        className={`w-6 h-6 text-xs rounded flex items-center justify-center font-bold transition-colors active:scale-90 ${qty <= 1 ? 'text-red-400 bg-red-900/30 hover:bg-red-900/50' : qtyBtn}`}
        aria-label={qty <= 1 ? 'Remove' : 'Decrease quantity'}
      >
        {qty <= 1 ? '×' : '−'}
      </button>
      <span className="w-5 text-xs text-center font-bold text-gray-200 tabular-nums">{qty}</span>
      <button
        onClick={() => onChangeQty(key, 1)}
        className={`w-6 h-6 text-xs rounded flex items-center justify-center font-bold transition-colors active:scale-90 ${qtyBtn}`}
        aria-label="Increase quantity"
      >
        +
      </button>
    </div>
  );
}

function SetGroupList({ groups, percentage, priceMode, onAdd, onChangeQty, onRemove, tradeCards, accentColor, showSetHeaders }: {
  groups: SetSearchGroup[];
  percentage: number;
  priceMode: PriceMode;
  onAdd: (card: CardVariant) => void;
  onChangeQty: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  tradeCards: TradeCard[];
  accentColor: string;
  showSetHeaders: boolean;
}) {
  return (
    <div className="divide-y divide-space-700">
      {groups.map(setGroup => (
        <div key={setGroup.setSlug}>
          {showSetHeaders && (
            <div className="px-2.5 py-1.5 bg-space-700 sticky top-0 z-10">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                {setGroup.setCode}
              </span>
              <span className="text-[10px] text-gray-600 ml-1.5">{setGroup.setName}</span>
            </div>
          )}
          <div className="divide-y divide-space-700/50">
            {setGroup.groups.map(group => (
              <div key={`${setGroup.setSlug}-${group.baseName}`} className="px-2.5 py-2">
                <div className="font-medium text-gray-200 text-xs mb-1.5 truncate">
                  {group.baseName}
                </div>
                <div className="space-y-1.5">
                  {group.variants.map((card, i) => {
                    const adjusted = adjustPrice(getCardPrice(card, priceMode), percentage);
                    const altAdj = adjustPrice(getAltPrice(card, priceMode), percentage);
                    const variantLabel = extractVariantLabel(card.name);
                    const tcgUrl = cardTcgPlayerUrl(card.productId);
                    return (
                      <div
                        key={`${card.name}-${card.set}-${i}`}
                        className="flex items-center gap-2"
                      >
                        <a
                          href={tcgUrl || '#'}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0"
                          onClick={tcgUrl ? undefined : (e) => e.preventDefault()}
                        >
                          <CardImage productId={card.productId} name={card.name} />
                        </a>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className={`text-[10px] leading-tight px-1 py-0.5 rounded ${variantBadgeColor(variantLabel)}`}>
                              {variantLabel}
                            </span>
                            {tcgUrl && (
                              <a
                                href={tcgUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-gray-600 hover:text-gold transition-colors"
                                title="View on TCGPlayer"
                              >
                                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </a>
                            )}
                          </div>
                          <span className="text-sm text-gold font-semibold">
                            {formatPrice(adjusted)}
                            {altAdj !== null && <span className="text-[10px] text-gray-600 ml-1">({formatPrice(altAdj)})</span>}
                          </span>
                        </div>
                        <QtyControls
                          card={card}
                          qty={tradeCards.find(tc => tradeCardKey(tc.card) === tradeCardKey(card))?.qty ?? 0}
                          onAdd={onAdd}
                          onChangeQty={onChangeQty}
                          onRemove={onRemove}
                          accentColor={accentColor}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SearchResults({ results, percentage, priceMode, onAdd, onChangeQty, onRemove, tradeCards, isSearching, query, accentColor, isExpanded, setFilterLabel, onExpandSearch }: SearchResultsProps) {
  const [activeTab, setActiveTab] = useState<ResultTab>('main');

  if (!query || query.length < 2) return null;

  if (isSearching) {
    return (
      <div className="bg-space-800 border border-space-600 rounded-lg mt-1 p-3 text-center text-gray-500 text-sm">
        Searching...
      </div>
    );
  }

  const showExpandBtn = !isExpanded && setFilterLabel;
  const hasResults = results.some(sg => sg.groups.length > 0);

  if (!hasResults) {
    return (
      <div className="bg-space-800 border border-space-600 rounded-lg mt-1 p-3 text-center">
        <div className="text-gray-500 text-sm">
          No cards found{setFilterLabel ? ` in ${setFilterLabel}` : ''}
        </div>
        {showExpandBtn && (
          <button
            onClick={onExpandSearch}
            className="mt-2 text-xs text-gold hover:text-gold-bright transition-colors"
          >
            Search all sets
          </button>
        )}
      </div>
    );
  }

  const mainResults = results.filter(sg => !promoSlugs.has(sg.setSlug));
  const promoResults = results.filter(sg => promoSlugs.has(sg.setSlug));
  const mainCount = mainResults.reduce((n, sg) => n + sg.groups.length, 0);
  const promoCount = promoResults.reduce((n, sg) => n + sg.groups.length, 0);
  const showTabs = mainCount > 0 && promoCount > 0;
  // If only one category has results, show it directly without tabs
  const visibleResults = showTabs
    ? (activeTab === 'main' ? mainResults : promoResults)
    : (mainCount > 0 ? mainResults : promoResults);
  const showSetHeaders = visibleResults.length > 1;

  const tabBase = 'px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors';
  const tabActive = accentColor === 'blue'
    ? 'bg-blue-900/50 text-blue-300'
    : 'bg-emerald-900/50 text-emerald-300';
  const tabInactive = 'text-gray-500 hover:text-gray-300';

  return (
    <div className="bg-space-800 border border-space-600 rounded-lg mt-1">
      {showTabs && (
        <div className="flex items-center gap-1 px-2.5 pt-2 pb-1">
          <button
            onClick={() => setActiveTab('main')}
            className={`${tabBase} ${activeTab === 'main' ? tabActive : tabInactive}`}
          >
            Sets
            <span className="ml-1 text-[10px] opacity-70">{mainCount}</span>
          </button>
          <button
            onClick={() => setActiveTab('promo')}
            className={`${tabBase} ${activeTab === 'promo' ? tabActive : tabInactive}`}
          >
            Promos
            <span className="ml-1 text-[10px] opacity-70">{promoCount}</span>
          </button>
        </div>
      )}
      <SetGroupList
        groups={visibleResults}
        percentage={percentage}
        priceMode={priceMode}
        onAdd={onAdd}
        onChangeQty={onChangeQty}
        onRemove={onRemove}
        tradeCards={tradeCards}
        accentColor={accentColor}
        showSetHeaders={showSetHeaders}
      />
      {showExpandBtn && (
        <div className="px-2.5 py-2 text-center border-t border-space-700">
          <button
            onClick={onExpandSearch}
            className="text-[11px] text-gray-500 hover:text-gold transition-colors"
          >
            Don't see it? Search all sets
          </button>
        </div>
      )}
    </div>
  );
}
