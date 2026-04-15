import type { CardVariant } from '../types';
import type { SetSearchGroup } from '../hooks/useCardSearch';
import { variantRank, extractVariantLabel, isLeaderOrBaseGroup } from '../variants';

export interface CardRenderContext {
  leaderGroup: boolean;
  setSlug: string;
  setCode: string;
}

interface CardResultsGridProps {
  results: SetSearchGroup[];
  isSearching: boolean;
  /** Render a single card tile. Consumers control look + click semantics. */
  renderTile: (card: CardVariant, ctx: CardRenderContext) => React.ReactNode;
  /** Grid column classes for non-leader (portrait) groups. */
  portraitColsClass?: string;
  /** Grid column classes for leader (landscape) groups. */
  landscapeColsClass?: string;
  /** Message to show when results are empty. */
  emptyLabel?: string;
}

const DEFAULT_PORTRAIT_COLS = 'grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8';
const DEFAULT_LANDSCAPE_COLS = 'grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6';

// Single padding contract used by every surface that embeds this component,
// so sticky set-headers and tile grids always line up visually. Sticky
// headers extend edge-to-edge of the scroll viewport (no outer container
// padding); the tile grids inside get the horizontal padding.
const SECTION_PADDING_X = 'px-3 sm:px-6';

/**
 * Set-grouped, leader-orientation-aware search results.
 *
 * Owns its own scroll container so consumers can't accidentally introduce
 * top padding that would break sticky set headers (the "gap above the
 * divider" bug). Consumers place this as a flex child — it supplies its
 * own flex-1 min-h-0 overflow-y-auto.
 *
 * Filtering is the caller's responsibility: pass in the already-narrowed
 * results so this component stays focused on layout.
 */
export function CardResultsGrid({
  results,
  isSearching,
  renderTile,
  portraitColsClass = DEFAULT_PORTRAIT_COLS,
  landscapeColsClass = DEFAULT_LANDSCAPE_COLS,
  emptyLabel = 'No cards match your filters',
}: CardResultsGridProps) {
  if (isSearching) {
    return <CenteredMessage>Searching…</CenteredMessage>;
  }

  const hasResults = results.some(sg => sg.groups.length > 0);
  if (!hasResults) {
    return <CenteredMessage>{emptyLabel}</CenteredMessage>;
  }

  const showSetHeaders = results.length > 1;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="space-y-8 pb-6">
        {results.map(setGroup => (
          <section key={setGroup.setSlug}>
            {showSetHeaders && (
              <div
                className={`flex items-baseline gap-2 py-2 sticky -top-px bg-space-900 z-10 mb-4 border-b border-space-700 shadow-[0_8px_12px_-8px_rgba(0,0,0,0.8)] ${SECTION_PADDING_X}`}
              >
                <span className="text-[11px] font-bold text-gray-300 uppercase tracking-widest">
                  {setGroup.setCode}
                </span>
                <span className="text-[10px] text-gray-600">{setGroup.setName}</span>
              </div>
            )}
            <div className={`space-y-6 ${SECTION_PADDING_X}`}>
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
    </div>
  );
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className={`${SECTION_PADDING_X} pt-6`}>
        <div className="bg-space-800 border border-space-700 rounded-lg p-6 text-center text-gray-500 text-sm">
          {children}
        </div>
      </div>
    </div>
  );
}
