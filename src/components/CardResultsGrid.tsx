import type { CardVariant } from '../types';
import { SETS } from '../types';
import type { SetSearchGroup } from '../hooks/useCardSearch';
import { variantRank, extractVariantLabel, isLeaderOrBaseGroup } from '../variants';
import type { SearchScope } from '../hooks/useVariantFilter';

const promoSlugs = new Set(SETS.filter(s => s.category === 'promo').map(s => s.slug));

export interface CardRenderContext {
  leaderGroup: boolean;
  setSlug: string;
  setCode: string;
}

interface CardResultsGridProps {
  results: SetSearchGroup[];
  query: string;
  isSearching: boolean;
  scope: SearchScope;
  hiddenVariants: Set<string>;
  hiddenSets: Set<string>;
  /** Render a single card tile. Consumers control look + click semantics. */
  renderTile: (card: CardVariant, ctx: CardRenderContext) => React.ReactNode;
  /** Class names for the portrait and landscape grids. Defaults are tuned
   *  for the wide trade overlay; the list picker overrides for a tighter
   *  column count. */
  portraitColsClass?: string;
  landscapeColsClass?: string;
}

const DEFAULT_PORTRAIT_COLS = 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7';
const DEFAULT_LANDSCAPE_COLS = 'grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

/**
 * Filter-aware, set-grouped, leader-orientation-aware results grid.
 * Purely presentational — owns no state. The consumer decides how each
 * tile looks via `renderTile`.
 */
export function CardResultsGrid({
  results,
  query,
  isSearching,
  scope,
  hiddenVariants,
  hiddenSets,
  renderTile,
  portraitColsClass = DEFAULT_PORTRAIT_COLS,
  landscapeColsClass = DEFAULT_LANDSCAPE_COLS,
}: CardResultsGridProps) {
  if (!query || query.length < 2) return null;

  if (isSearching) {
    return <EmptyPanel>Searching…</EmptyPanel>;
  }

  const hasResults = results.some(sg => sg.groups.length > 0);
  if (!hasResults) {
    return <EmptyPanel>No cards found</EmptyPanel>;
  }

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
      <EmptyPanel>
        Everything matching "{query}" is hidden by your current filters.
      </EmptyPanel>
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
              const gridCols = leaderGroup ? landscapeColsClass : portraitColsClass;
              return (
                <div key={`${setGroup.setSlug}-${group.baseName}`}>
                  <div className="px-1 pb-2 text-xs font-medium text-gray-300 truncate">
                    {group.baseName}
                  </div>
                  <div className={`grid ${gridCols} gap-3`}>
                    {[...group.variants]
                      .sort((a, b) => variantRank(extractVariantLabel(a.name)) - variantRank(extractVariantLabel(b.name)))
                      .map(card => renderTile(card, {
                        leaderGroup,
                        setSlug: setGroup.setSlug,
                        setCode: setGroup.setCode,
                      }))}
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

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-space-800 border border-space-700 rounded-lg mt-1 p-6 text-center text-gray-500 text-sm">
      {children}
    </div>
  );
}
