import { useMemo, useState } from 'react';
import type { CardVariant, PriceMode } from '../types';
import { SETS } from '../types';
import type { SharedLists } from '../hooks/useSharedLists';
import {
  cardImageUrl,
  adjustPrice,
  getCardPrice,
} from '../services/priceService';
import {
  extractVariantLabel,
  variantBadgeColor,
  variantDisplayLabel,
  variantChipLabel,
  CANONICAL_VARIANTS,
  type CanonicalVariant,
} from '../variants';
import { bestMatchForWant } from '../listMatching';
import type { WantsItem, VariantRestriction } from '../persistence';
import { MAIN_GROUP, SPECIAL_GROUP } from '../applySelectionFilters';
import { Logo } from './Logo';
import { BetaBadge } from './BetaBadge';
import { CollapsibleChipFilter, Chip } from './CollapsibleChipFilter';

const MAIN_SETS = SETS.filter(s => s.category === 'main');
const MAIN_SET_SLUGS = new Set(MAIN_SETS.map(s => s.slug));
const SPECIAL_SET_SLUGS = new Set(SETS.filter(s => s.category === 'promo').map(s => s.slug));
const SET_CODE_BY_SLUG = new Map(SETS.map(s => [s.slug, s.code] as const));

interface ResolvedRow {
  key: string;
  card: CardVariant;
  qty: number;
  /** For wants rows only; tells us whether to fuzzy-match the variant
   *  filter against the restriction rather than the resolved rep. */
  restriction?: VariantRestriction;
  isPriority?: boolean;
}

interface ListViewProps {
  sharedLists: SharedLists;
  byFamilyAll: Map<string, CardVariant[]>;
  byProductId: Map<string, CardVariant>;
  percentage: number;
  priceMode: PriceMode;
  isAnyLoading: boolean;
  onStartTrade: () => void;
}

/**
 * Shared-list landing page. A recipient clicking a ?w=…&a=… link
 * lands here and needs to quickly figure out whether they have
 * anything the sender wants. That means:
 *   - Compact row layout (not a grid of card art) so many items fit
 *     without scrolling.
 *   - Filter controls (search, variant, set) so a long list can be
 *     narrowed to just the subset the recipient cares about.
 *   - Wants rendered first + prominently; Available is secondary.
 *
 * The "Start a trade" button flips the app into trade mode with the
 * shared lists already piped into the add-card empty state (the
 * trade-side handler expands the "From the shared link" section so
 * the recipient lands directly on the sender's wants).
 */
export function ListView({
  sharedLists,
  byFamilyAll,
  byProductId,
  percentage,
  priceMode,
  isAnyLoading,
  onStartTrade,
}: ListViewProps) {
  const [query, setQuery] = useState('');
  const [selectedVariants, setSelectedVariants] = useState<CanonicalVariant[]>([]);
  const [selectedSets, setSelectedSets] = useState<string[]>([]);

  const wantsRows = useMemo<ResolvedRow[]>(() => {
    return sharedLists.wants
      .map((w, i) => {
        const candidates = byFamilyAll.get(w.familyId) ?? [];
        if (candidates.length === 0) return null;
        const synth = { ...w, id: '_', addedAt: 0 } as WantsItem;
        const card = bestMatchForWant(synth, candidates, priceMode);
        if (!card) return null;
        return {
          key: 'w-' + i,
          card,
          qty: w.qty,
          restriction: w.restriction,
          isPriority: w.isPriority,
        } as ResolvedRow;
      })
      .filter((r): r is ResolvedRow => r !== null);
  }, [sharedLists.wants, byFamilyAll, priceMode]);

  const availableRows = useMemo<ResolvedRow[]>(() => {
    return sharedLists.available
      .map((a, i) => {
        const card = byProductId.get(a.productId);
        if (!card) return null;
        return {
          key: 'a-' + i,
          card,
          qty: a.qty,
        } as ResolvedRow;
      })
      .filter((r): r is ResolvedRow => r !== null);
  }, [sharedLists.available, byProductId]);

  const filterRow = (row: ResolvedRow, isWant: boolean): boolean => {
    if (query.trim().length > 0) {
      const q = query.trim().toLowerCase();
      const name = (row.card.displayName ?? row.card.name).toLowerCase();
      if (!name.includes(q)) return false;
    }
    if (selectedVariants.length > 0) {
      if (isWant && row.restriction) {
        // A want with restriction 'any' matches any variant filter.
        // A restricted want matches if its allowed variants overlap
        // with the recipient's filter.
        if (row.restriction.mode === 'any') {
          // pass
        } else if (!row.restriction.variants.some(v => selectedVariants.includes(v))) {
          return false;
        }
      } else {
        const variant = extractVariantLabel(row.card.name);
        if (!selectedVariants.includes(variant as CanonicalVariant)) return false;
      }
    }
    if (selectedSets.length > 0) {
      const slug = row.card.set;
      const includesMain = selectedSets.includes(MAIN_GROUP);
      const includesSpecial = selectedSets.includes(SPECIAL_GROUP);
      const exact = selectedSets.filter(s => !s.startsWith('group:'));
      const pass =
        exact.includes(slug)
        || (includesMain && MAIN_SET_SLUGS.has(slug))
        || (includesSpecial && SPECIAL_SET_SLUGS.has(slug));
      if (!pass) return false;
    }
    return true;
  };

  const filteredWants = useMemo(
    () => wantsRows.filter(r => filterRow(r, true)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wantsRows, query, selectedVariants, selectedSets],
  );
  const filteredAvailable = useMemo(
    () => availableRows.filter(r => filterRow(r, false)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [availableRows, query, selectedVariants, selectedSets],
  );

  const declaredWants = sharedLists.wants.length;
  const declaredAvailable = sharedLists.available.length;
  const missingWants = declaredWants - wantsRows.length;
  const missingAvailable = declaredAvailable - availableRows.length;
  const hasMissing = missingWants > 0 || missingAvailable > 0;

  const toggleVariant = (v: CanonicalVariant) => {
    setSelectedVariants(prev =>
      prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v],
    );
  };
  const toggleSet = (slug: string) => {
    setSelectedSets(prev => {
      const base = slug.startsWith('group:')
        ? prev.filter(s => !s.startsWith('group:'))
        : prev.filter(s => !s.startsWith('group:'));
      if (slug.startsWith('group:')) {
        return base.includes(slug) ? base.filter(s => s !== slug) : [...base, slug];
      }
      return prev.includes(slug)
        ? prev.filter(x => x !== slug)
        : [...base.filter(s => s !== slug), slug];
    });
  };
  const clearFilters = () => {
    setQuery('');
    setSelectedVariants([]);
    setSelectedSets([]);
  };

  const hasAnyFilter = query.length > 0 || selectedVariants.length > 0 || selectedSets.length > 0;
  const variantSummary = selectedVariants.length === 0
    ? 'Any'
    : selectedVariants.length === 1
      ? variantChipLabel(selectedVariants[0])
      : `${selectedVariants.length} selected`;
  const setSummary = selectedSets.length === 0
    ? 'All sets'
    : selectedSets.length === 1
      ? (selectedSets[0] === MAIN_GROUP ? 'Main' : selectedSets[0] === SPECIAL_GROUP ? 'Special' : SET_CODE_BY_SLUG.get(selectedSets[0]) ?? selectedSets[0])
      : `${selectedSets.length} selected`;

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <header className="px-3 sm:px-6 pt-3 pb-2 max-w-5xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <h1 className="relative flex items-center select-none shrink-0">
            <Logo className="w-6 h-6 sm:w-7 sm:h-7 shrink-0" />
            <span className="ml-px text-sm sm:text-lg font-bold tracking-[0.1em] sm:tracking-[0.12em] leading-none">
              <span className="text-gray-200 uppercase">SWU</span><span className="text-gold uppercase">Trade</span>
            </span>
            <BetaBadge className="absolute bottom-0 left-7 sm:left-8 translate-y-[calc(100%-2px)]" />
          </h1>
          <div className="ml-auto">
            <button
              type="button"
              onClick={onStartTrade}
              className="flex items-center gap-1.5 px-3 sm:px-4 h-9 rounded-lg bg-gold/15 border border-gold/40 hover:bg-gold/25 hover:border-gold/60 text-gold text-xs sm:text-sm font-bold tracking-wide uppercase transition-colors"
            >
              <span>Start a trade</span>
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </button>
          </div>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-[11px] tracking-[0.18em] uppercase text-gray-500 font-bold">Shared list</span>
          <span className="text-[11px] text-gray-600">
            {wantsRows.length > 0 && `${wantsRows.length} want${wantsRows.length === 1 ? '' : 's'}`}
            {wantsRows.length > 0 && availableRows.length > 0 && ' · '}
            {availableRows.length > 0 && `${availableRows.length} available`}
          </span>
        </div>
      </header>

      {hasMissing && !isAnyLoading && (
        <div className="px-3 sm:px-6 max-w-5xl mx-auto w-full">
          <div className="text-[11px] text-amber-300 bg-amber-950/30 border border-amber-500/30 rounded-md px-3 py-2">
            {missingWants + missingAvailable} item(s) in this list aren't available in our database yet — they may be from sets we haven't indexed.
          </div>
        </div>
      )}

      {/* Filters — text search + variant/set chip collapsibles. Ephemeral
          (not persisted) since they're recipient-scoped, not the sender's
          intent. */}
      <div className="px-3 sm:px-6 pt-3 max-w-5xl mx-auto w-full space-y-2">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter by name..."
          className="w-full px-3 py-2 rounded-lg bg-space-800 border border-space-700 focus:border-gold/50 focus:outline-none text-sm text-gray-100 placeholder:text-gray-600"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="flex items-start gap-2 flex-wrap">
          <CollapsibleChipFilter
            label="Variant"
            summary={variantSummary}
            action={selectedVariants.length > 0 ? (
              <button
                type="button"
                onClick={() => setSelectedVariants([])}
                className="text-[10px] text-gray-500 hover:text-gold transition-colors"
              >
                Clear
              </button>
            ) : undefined}
          >
            <Chip
              active={selectedVariants.length === 0}
              onClick={() => setSelectedVariants([])}
              colorClass="bg-gold/15 text-gold border-gold/40"
            >
              Any
            </Chip>
            {CANONICAL_VARIANTS.map(v => (
              <Chip
                key={v}
                active={selectedVariants.includes(v)}
                onClick={() => toggleVariant(v)}
                colorClass={variantBadgeColor(v)}
              >
                {variantChipLabel(v)}
              </Chip>
            ))}
          </CollapsibleChipFilter>

          <CollapsibleChipFilter
            label="Set"
            summary={setSummary}
            action={selectedSets.length > 0 ? (
              <button
                type="button"
                onClick={() => setSelectedSets([])}
                className="text-[10px] text-gray-500 hover:text-gold transition-colors"
              >
                Clear
              </button>
            ) : undefined}
          >
            <Chip
              active={selectedSets.length === 0}
              onClick={() => setSelectedSets([])}
              colorClass="bg-gold/15 text-gold border-gold/40"
            >
              All
            </Chip>
            <Chip
              active={selectedSets.includes(MAIN_GROUP)}
              onClick={() => toggleSet(MAIN_GROUP)}
              colorClass="bg-gold/15 text-gold border-gold/40"
            >
              Main
            </Chip>
            <Chip
              active={selectedSets.includes(SPECIAL_GROUP)}
              onClick={() => toggleSet(SPECIAL_GROUP)}
              colorClass="bg-gold/15 text-gold border-gold/40"
            >
              Special
            </Chip>
            <span className="w-px h-5 bg-space-700 mx-1" aria-hidden />
            {MAIN_SETS.map(s => (
              <Chip
                key={s.slug}
                active={selectedSets.includes(s.slug)}
                onClick={() => toggleSet(s.slug)}
              >
                {s.code}
              </Chip>
            ))}
          </CollapsibleChipFilter>

          {hasAnyFilter && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-[11px] text-gray-500 hover:text-gold transition-colors px-2 py-1"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      <main className="flex-1 px-3 sm:px-6 pb-8 pt-4 max-w-5xl mx-auto w-full">
        {wantsRows.length === 0 && availableRows.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-center text-gray-500 py-20">
            {isAnyLoading ? 'Loading card data…' : 'No items in this shared list.'}
          </div>
        ) : (
          <div className="space-y-6">
            {wantsRows.length > 0 && (
              <ListSection
                title="Wants"
                tone="blue"
                rows={filteredWants}
                totalRows={wantsRows.length}
                percentage={percentage}
                priceMode={priceMode}
                hasAnyFilter={hasAnyFilter}
              />
            )}
            {availableRows.length > 0 && (
              <ListSection
                title="Available"
                tone="emerald"
                rows={filteredAvailable}
                totalRows={availableRows.length}
                percentage={percentage}
                priceMode={priceMode}
                hasAnyFilter={hasAnyFilter}
              />
            )}
          </div>
        )}
      </main>

      <footer className="shrink-0 px-3 sm:px-6 pb-4 text-center text-[10px] text-gray-600 max-w-5xl mx-auto w-full">
        <span>Anonymous list shared via SWUTrade · </span>
        <button
          type="button"
          onClick={onStartTrade}
          className="text-gold/80 hover:text-gold underline transition-colors"
        >
          Start a trade with these cards
        </button>
      </footer>
    </div>
  );
}

interface ListSectionProps {
  title: string;
  tone: 'blue' | 'emerald';
  rows: ResolvedRow[];
  totalRows: number;
  percentage: number;
  priceMode: PriceMode;
  hasAnyFilter: boolean;
}

function ListSection({
  title,
  tone,
  rows,
  totalRows,
  percentage,
  priceMode,
  hasAnyFilter,
}: ListSectionProps) {
  const accent = tone === 'blue'
    ? 'text-blue-300 border-blue-500/30'
    : 'text-emerald-300 border-emerald-500/30';

  const counter = hasAnyFilter && rows.length !== totalRows
    ? `${rows.length} of ${totalRows}`
    : `${totalRows}`;

  return (
    <section>
      <div className={`flex items-baseline gap-2 pb-2 mb-3 border-b ${accent}`}>
        <span className="text-xs sm:text-sm font-bold tracking-[0.18em] uppercase">{title}</span>
        <span className="text-[11px] text-gray-600">{counter}</span>
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] text-gray-500 italic py-4">
          No {title.toLowerCase()} match the current filter.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-space-800">
          {rows.map(row => (
            <ListRow
              key={row.key}
              row={row}
              tone={tone}
              percentage={percentage}
              priceMode={priceMode}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ListRowProps {
  row: ResolvedRow;
  tone: 'blue' | 'emerald';
  percentage: number;
  priceMode: PriceMode;
}

function ListRow({ row, tone, percentage, priceMode }: ListRowProps) {
  const { card, qty, restriction, isPriority } = row;
  const variant = extractVariantLabel(card.name);
  const variantLabel = variantDisplayLabel(variant);
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');
  const display = card.displayName ?? card.name.replace(/\s*\([^)]*\)\s*$/, '');
  const setCode = SET_CODE_BY_SLUG.get(card.set) ?? card.set.toUpperCase().slice(0, 4);
  // For wants with a multi-variant restriction, surface the full
  // restriction ("HS or HSF") rather than just the cheapest rep. A
  // recipient scanning needs to know every variant the sender would
  // accept, not just which one happens to be cheapest right now.
  const restrictionLabel = restriction && restriction.mode === 'restricted' && restriction.variants.length > 1
    ? restriction.variants.map(variantChipLabel).join(' / ')
    : null;

  const qtyAccent = tone === 'blue' ? 'text-blue-200' : 'text-emerald-200';

  return (
    <li className="flex items-center gap-3 py-1.5">
      <div className="w-8 h-11 shrink-0 rounded bg-space-900 border border-space-800 overflow-hidden">
        {imgUrl ? (
          <img src={imgUrl} alt="" loading="lazy" className="w-full h-full object-cover" />
        ) : null}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {isPriority && (
            <span className="text-gold-bright shrink-0" aria-label="Priority" style={{ fontSize: 12, lineHeight: 1 }}>
              ★
            </span>
          )}
          <span className="text-sm text-gray-100 truncate">{display}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] font-bold tracking-widest uppercase text-gray-500">
            {setCode}
          </span>
          {restrictionLabel ? (
            <span className="text-[9px] leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide bg-gold/15 text-gold border border-gold/30">
              {restrictionLabel}
            </span>
          ) : variantLabel ? (
            <span className={`text-[9px] leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide ${variantBadgeColor(variant)}`}>
              {variantLabel}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 text-right">
        {qty > 1 && (
          <span className={`text-xs font-bold tabular-nums ${qtyAccent}`}>×{qty}</span>
        )}
        {price !== null && (
          <span className="text-xs text-gold font-semibold tabular-nums w-14 text-right">
            ${price.toFixed(2)}
          </span>
        )}
      </div>
    </li>
  );
}
