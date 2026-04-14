import type { PriceMode } from '../types';
import { PriceModeToggle } from './PriceModeToggle';
import { variantBadgeColor } from '../utils/variantBadge';
import type { SearchScope } from '../hooks/useVariantFilter';

const FILTERABLE_VARIANTS = [
  'Standard',
  'Foil',
  'Hyperspace',
  'Hyperspace Foil',
  'Prestige',
  'Prestige Foil',
  'Serialized',
  'Showcase',
];

interface SearchControlsProps {
  scope: SearchScope;
  setScope: (s: SearchScope) => void;
  hiddenVariants: Set<string>;
  hiddenSets: Set<string>;
  toggleVariant: (v: string) => void;
  toggleSet: (slug: string) => void;
  clearAll: () => void;
  totalHidden: number;
  relevantSets: Map<string, string>; // slug → code, sets appearing in current results
  filterOpen: boolean;
  setFilterOpen: (open: boolean) => void;
  priceMode: PriceMode;
  onPriceModeChange: (mode: PriceMode) => void;
  // Counts per scope for the toggle badges
  mainCount: number;
  promoCount: number;
}

// Unified chrome for the search overlay — scope toggle, filters, and
// pricing all in one horizontal pill-style strip mirroring the main
// view's top-bar control group.
export function SearchControls({
  scope,
  setScope,
  hiddenVariants,
  hiddenSets,
  toggleVariant,
  toggleSet,
  clearAll,
  totalHidden,
  relevantSets,
  filterOpen,
  setFilterOpen,
  priceMode,
  onPriceModeChange,
  mainCount,
  promoCount,
}: SearchControlsProps) {
  const scopeBtn = (s: SearchScope, label: string, count: number | null) => (
    <button
      type="button"
      onClick={() => setScope(s)}
      className={`px-2 sm:px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
        scope === s
          ? 'bg-gold/20 text-gold'
          : 'text-gray-400 hover:text-gray-200'
      }`}
    >
      {label}
      {count !== null && (
        // Counts are secondary info — hide on mobile so the scope
        // toggle + Market/Low + Filters all fit on one row.
        <span className="hidden sm:inline ml-1 text-[10px] opacity-70">{count}</span>
      )}
    </button>
  );

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        {/* Scope toggle — persisted per device */}
        <div className="flex items-center gap-1 px-1 py-0.5 rounded-lg bg-space-800/60 border border-space-700">
          {scopeBtn('all', 'All', mainCount + promoCount)}
          {scopeBtn('main', 'Main', mainCount)}
          {scopeBtn('promo', 'Promo', promoCount)}
        </div>

        {/* Pricing */}
        <div className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg bg-space-800/60 border border-space-700">
          <PriceModeToggle value={priceMode} onChange={onPriceModeChange} />
        </div>

        {/* Filters toggle */}
        <button
          type="button"
          onClick={() => setFilterOpen(!filterOpen)}
          aria-expanded={filterOpen}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${
            totalHidden > 0
              ? 'bg-gold/15 text-gold border-gold/40 hover:bg-gold/20'
              : filterOpen
                ? 'bg-space-800 text-gray-200 border-gray-500'
                : 'bg-space-800/60 text-gray-400 border-space-700 hover:text-gray-200 hover:border-gray-500'
          }`}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.172a2 2 0 01-.586 1.414l-5.414 5.414A2 2 0 0014 14.414V19l-4 2v-6.586a2 2 0 00-.586-1.414L3.586 7.586A2 2 0 013 6.172V4z" />
          </svg>
          Filters
          {totalHidden > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gold/30 text-gold-bright">{totalHidden}</span>
          )}
        </button>
      </div>

      {/* Inline filter panel — reveals under the strip when open */}
      {filterOpen && (
        <div className="mt-2 rounded-lg border border-space-700 bg-space-800/80 p-3 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">Variants</span>
              {hiddenVariants.size > 0 && (
                <span className="text-[10px] text-gray-500">{hiddenVariants.size} hidden</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {FILTERABLE_VARIANTS.map(v => {
                const isHidden = hiddenVariants.has(v);
                return (
                  <button
                    key={v}
                    onClick={() => toggleVariant(v)}
                    className={`text-[10px] leading-none px-2 py-1 rounded font-medium transition-all ${variantBadgeColor(v)} ${isHidden ? 'opacity-30 line-through' : ''}`}
                    title={isHidden ? `Show ${v}` : `Hide ${v}`}
                  >
                    {v}
                  </button>
                );
              })}
            </div>
          </div>

          {relevantSets.size > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">Sets in results</span>
                {hiddenSets.size > 0 && (
                  <span className="text-[10px] text-gray-500">{hiddenSets.size} hidden</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {[...relevantSets.entries()].map(([slug, code]) => {
                  const isHidden = hiddenSets.has(slug);
                  return (
                    <button
                      key={slug}
                      onClick={() => toggleSet(slug)}
                      className={`text-[10px] leading-none px-2 py-1 rounded font-medium transition-all bg-space-700 text-gray-300 hover:bg-space-600 ${isHidden ? 'opacity-30 line-through' : ''}`}
                      title={isHidden ? `Show ${code}` : `Hide ${code}`}
                    >
                      {code}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {totalHidden > 0 && (
            <div className="flex justify-end pt-1">
              <button
                onClick={clearAll}
                className="text-[11px] text-gray-500 hover:text-gold transition-colors"
              >
                Reset filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
