import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CardVariant } from '../types';
import type { SetSearchGroup } from '../hooks/useCardSearch';
import { variantRank, extractVariantLabel, isLeaderOrBaseGroup } from '../variants';
import type { CardGroup } from '../types';

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

const SECTION_PADDING_X = 'px-3 sm:px-6';

interface Row {
  setSlug: string;
  setCode: string;
  setName: string;
  group: CardGroup;
  firstInSet: boolean;
}

/**
 * Virtualized search results: only the rows currently in (or near) the
 * viewport are mounted, regardless of how many cards the filters
 * return. Handles the browse-all case (hundreds of tiles) without
 * melting the mobile main thread. Row heights are measured on render
 * so expanded Available stacks (2-row grids) auto-size.
 *
 * A single sticky bar at the top of the scroll container shows which
 * set the currently-visible rows belong to — updated off the first
 * virtual item's setCode so it tracks as the user scrolls between
 * sets.
 */
export function CardResultsGrid({
  results,
  isSearching,
  renderTile,
  portraitColsClass = DEFAULT_PORTRAIT_COLS,
  landscapeColsClass = DEFAULT_LANDSCAPE_COLS,
  emptyLabel = 'No cards match your filters',
}: CardResultsGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const { rows, showSetHeaders } = useMemo(() => {
    const r: Row[] = [];
    const setsSeen = new Set<string>();
    for (const sg of results) {
      let first = true;
      for (const g of sg.groups) {
        r.push({
          setSlug: sg.setSlug,
          setCode: sg.setCode,
          setName: sg.setName,
          group: g,
          firstInSet: first,
        });
        first = false;
      }
      if (sg.groups.length > 0) setsSeen.add(sg.setSlug);
    }
    return { rows: r, showSetHeaders: setsSeen.size > 1 };
  }, [results]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: i => {
      const row = rows[i];
      const leader = isLeaderOrBaseGroup(row.group.variants);
      const wrap = row.group.variants.length > 4 ? 2 : 1;
      return (leader ? 180 : 260) * wrap;
    },
    overscan: 4,
  });

  if (isSearching) {
    return <CenteredMessage>Searching…</CenteredMessage>;
  }

  const hasResults = results.some(sg => sg.groups.length > 0);
  if (!hasResults) {
    return <CenteredMessage>{emptyLabel}</CenteredMessage>;
  }

  const virtualItems = virtualizer.getVirtualItems();
  const stickyRow = virtualItems[0] ? rows[virtualItems[0].index] : null;

  return (
    <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto">
      {showSetHeaders && stickyRow && (
        <div
          className={`sticky top-0 z-10 bg-space-900 border-b border-space-700 shadow-[0_8px_12px_-8px_rgba(0,0,0,0.8)] flex items-baseline gap-2 py-2 ${SECTION_PADDING_X}`}
        >
          <span className="text-[11px] font-bold text-gray-300 uppercase tracking-widest">
            {stickyRow.setCode}
          </span>
          <span className="text-[10px] text-gray-600">{stickyRow.setName}</span>
        </div>
      )}
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map(vi => {
          const row = rows[vi.index];
          return (
            <div
              key={vi.key}
              ref={virtualizer.measureElement}
              data-index={vi.index}
              className="absolute inset-x-0"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <GroupRow
                group={row.group}
                setSlug={row.setSlug}
                setCode={row.setCode}
                portraitColsClass={portraitColsClass}
                landscapeColsClass={landscapeColsClass}
                spacedTop={row.firstInSet && vi.index !== 0}
                renderTile={renderTile}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface GroupRowProps {
  group: CardGroup;
  setSlug: string;
  setCode: string;
  portraitColsClass: string;
  landscapeColsClass: string;
  spacedTop: boolean;
  renderTile: (card: CardVariant, ctx: CardRenderContext) => React.ReactNode;
}

function GroupRow({
  group,
  setSlug,
  setCode,
  portraitColsClass,
  landscapeColsClass,
  spacedTop,
  renderTile,
}: GroupRowProps) {
  const leaderGroup = isLeaderOrBaseGroup(group.variants);
  const gridCols = leaderGroup ? landscapeColsClass : portraitColsClass;
  const sortedVariants = [...group.variants].sort(
    (a, b) => variantRank(extractVariantLabel(a.name)) - variantRank(extractVariantLabel(b.name)),
  );
  return (
    <div className={`${SECTION_PADDING_X} ${spacedTop ? 'pt-6' : 'pt-2'} pb-6`}>
      <div className="px-1 pb-2 text-xs font-medium text-gray-300 truncate">{group.baseName}</div>
      <div className={`grid ${gridCols} gap-3`}>
        {sortedVariants.map(card => renderTile(card, { leaderGroup, setSlug, setCode }))}
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
