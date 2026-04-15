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

type Row =
  | { kind: 'header'; setSlug: string; setCode: string; setName: string }
  | { kind: 'group'; setSlug: string; setCode: string; group: CardGroup };

/**
 * Virtualized search results: only the rows currently in (or near) the
 * viewport are mounted, regardless of how many cards the filters
 * return. Handles the browse-all case (hundreds of tiles) without
 * melting the mobile main thread. Row heights are measured on render
 * so expanded Available tiles (multi-row grids) auto-size.
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
    const showHeaders = results.length > 1;
    const r: Row[] = [];
    for (const sg of results) {
      if (showHeaders) {
        r.push({ kind: 'header', setSlug: sg.setSlug, setCode: sg.setCode, setName: sg.setName });
      }
      for (const g of sg.groups) {
        r.push({ kind: 'group', setSlug: sg.setSlug, setCode: sg.setCode, group: g });
      }
    }
    return { rows: r, showSetHeaders: showHeaders };
  }, [results]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    // Rough estimates — measureElement refines per-row on render.
    // Set headers are short; group rows contain a tile grid with
    // baseName label (portrait tiles are taller than landscape).
    estimateSize: i => {
      const row = rows[i];
      if (row.kind === 'header') return 48;
      const leader = isLeaderOrBaseGroup(row.group.variants);
      // Expanded groups can wrap to two visual rows at mobile widths
      // (4-col grid fits ~4 tiles; 5+ wraps). Estimate accordingly.
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

  return (
    <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto">
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
              {row.kind === 'header' ? (
                <SetHeader setCode={row.setCode} setName={row.setName} first={vi.index === 0} />
              ) : (
                <GroupRow
                  group={row.group}
                  setSlug={row.setSlug}
                  setCode={row.setCode}
                  portraitColsClass={portraitColsClass}
                  landscapeColsClass={landscapeColsClass}
                  withTopSpacing={!showSetHeaders && vi.index === 0}
                  renderTile={renderTile}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SetHeader({ setCode, setName, first }: { setCode: string; setName: string; first: boolean }) {
  return (
    <div
      className={`flex items-baseline gap-2 py-2 mb-3 border-b border-space-700 ${SECTION_PADDING_X} ${first ? '' : 'pt-6'}`}
    >
      <span className="text-[11px] font-bold text-gray-300 uppercase tracking-widest">{setCode}</span>
      <span className="text-[10px] text-gray-600">{setName}</span>
    </div>
  );
}

interface GroupRowProps {
  group: CardGroup;
  setSlug: string;
  setCode: string;
  portraitColsClass: string;
  landscapeColsClass: string;
  withTopSpacing: boolean;
  renderTile: (card: CardVariant, ctx: CardRenderContext) => React.ReactNode;
}

function GroupRow({
  group,
  setSlug,
  setCode,
  portraitColsClass,
  landscapeColsClass,
  withTopSpacing,
  renderTile,
}: GroupRowProps) {
  const leaderGroup = isLeaderOrBaseGroup(group.variants);
  const gridCols = leaderGroup ? landscapeColsClass : portraitColsClass;
  const sortedVariants = [...group.variants].sort(
    (a, b) => variantRank(extractVariantLabel(a.name)) - variantRank(extractVariantLabel(b.name)),
  );
  return (
    <div className={`${SECTION_PADDING_X} ${withTopSpacing ? 'pt-2' : ''} pb-6`}>
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
