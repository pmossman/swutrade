import { useMemo } from 'react';
import { SETS } from '../types';
import { CANONICAL_VARIANTS, variantBadgeColor, variantChipLabel, type CanonicalVariant } from '../variants';
import type { SelectionFilters } from '../hooks/useSelectionFilters';
import { CollapsibleChipFilter, Chip } from './CollapsibleChipFilter';
import { MAIN_GROUP, SPECIAL_GROUP } from '../applySelectionFilters';
import { summarizeSelection, setSummaryLabel } from '../utils/filterSummaries';

const MAIN_SETS = SETS.filter(s => s.category === 'main');

const GOLD_CHIP = 'bg-gold/15 text-gold border-gold/40';

// Single source of truth for the "Any variant" pill — used both in
// the collapsed summary AND the expanded chip strip. Gradient picks
// up hues from the variant palette so the no-filter state feels
// deliberate, not absent. (Set's "All" / "Main" / "Special" presets
// stay on GOLD_CHIP because they're a different concept.)
const ANY_VARIANT_BADGE = 'text-white bg-gradient-to-r from-sky-700/70 via-fuchsia-700/70 to-amber-600/70';

interface VariantChipGroupProps {
  selectedVariants: readonly string[];
  onToggle: (v: CanonicalVariant) => void;
  onClear: () => void;
}

/**
 * Variant filter chip row — Any + every CANONICAL_VARIANT. Stateless;
 * caller owns the selectedVariants array and the toggle/clear handlers
 * (so this works against a persisted hook OR ephemeral useState). The
 * collapsed summary renders the selected variants as colored badge
 * pills (matching the per-tile variant badge palette) so users see at
 * a glance which variant filters are active without expanding the
 * strip.
 */
export function VariantChipGroup({
  selectedVariants,
  onToggle,
  onClear,
}: VariantChipGroupProps) {
  const selected = selectedVariants as readonly string[];
  const summary = selected.length === 0
    ? <SummaryPill colorClass={ANY_VARIANT_BADGE}>Any</SummaryPill>
    : selected.length <= 3
      ? (
        <>
          {selected.map(v => (
            <SummaryPill key={v} colorClass={variantBadgeColor(v)}>
              {variantChipLabel(v)}
            </SummaryPill>
          ))}
        </>
      )
      : `${selected.length} selected`;
  return (
    <CollapsibleChipFilter
      label="Variant"
      summary={summary}
      action={selected.length > 0 ? <ClearAction onClick={onClear} /> : undefined}
    >
      <Chip active={selected.length === 0} onClick={onClear} colorClass={ANY_VARIANT_BADGE}>
        Any
      </Chip>
      {CANONICAL_VARIANTS.map(v => (
        <Chip
          key={v}
          active={selected.includes(v)}
          onClick={() => onToggle(v)}
          colorClass={variantBadgeColor(v)}
        >
          {variantChipLabel(v)}
        </Chip>
      ))}
    </CollapsibleChipFilter>
  );
}

interface SetChipGroupProps {
  summary: string;
  selectedSets: readonly string[];
  /** Toggle a specific set slug. Implementation should strip any active
   *  group-preset slug (Main / Special) so individual + preset stay
   *  mutually exclusive — see toggleSetReducer. */
  onToggleSet: (slug: string) => void;
  /** Pick a group preset slug or pass null to clear. Implementation
   *  should wipe the selectedSets array entirely so groups don't stack
   *  with individual chips — see replaceGroupReducer. */
  onSelectGroup: (group: string | null) => void;
  onClear: () => void;
}

/**
 * Set filter chip row — All / Main / Special presets, then per-main-set
 * code chips. Promo sets aren't in the chip list; users either reach
 * them via the Special preset or by typing a code into the search box.
 */
export function SetChipGroup({
  summary,
  selectedSets,
  onToggleSet,
  onSelectGroup,
  onClear,
}: SetChipGroupProps) {
  return (
    <CollapsibleChipFilter
      label="Set"
      summary={summary}
      action={selectedSets.length > 0 ? <ClearAction onClick={onClear} /> : undefined}
    >
      <Chip active={selectedSets.length === 0} onClick={onClear} colorClass={GOLD_CHIP}>
        All
      </Chip>
      <Chip
        active={selectedSets.includes(MAIN_GROUP)}
        onClick={() => onSelectGroup(selectedSets.includes(MAIN_GROUP) ? null : MAIN_GROUP)}
        colorClass={GOLD_CHIP}
      >
        Main
      </Chip>
      <Chip
        active={selectedSets.includes(SPECIAL_GROUP)}
        onClick={() => onSelectGroup(selectedSets.includes(SPECIAL_GROUP) ? null : SPECIAL_GROUP)}
        colorClass={GOLD_CHIP}
      >
        Special
      </Chip>
      <span className="w-px h-5 bg-space-700 mx-1" aria-hidden />
      {MAIN_SETS.map(s => (
        <Chip
          key={s.slug}
          active={selectedSets.includes(s.slug)}
          onClick={() => onToggleSet(s.slug)}
        >
          {s.code}
        </Chip>
      ))}
    </CollapsibleChipFilter>
  );
}

function ClearAction({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] text-gray-500 hover:text-gold transition-colors"
    >
      Clear
    </button>
  );
}

/**
 * Compact non-interactive variant badge used in the collapsed-state
 * summary of VariantChipGroup. Same color palette as the expanded
 * Chip but smaller, and a span (not a button) since the parent
 * button already handles toggle. */
function SummaryPill({ colorClass, children }: { colorClass: string; children: React.ReactNode }) {
  return (
    <span className={`text-[9px] leading-none px-1.5 py-0.5 rounded font-bold uppercase tracking-wide ${colorClass}`}>
      {children}
    </span>
  );
}

interface SelectionFilterBarProps {
  filters: SelectionFilters;
  /** Hide the Variant filter. Available picker turns this on — every
   *  tap there commits an exact productId, so narrowing the view by
   *  variant would just hide cards without changing semantics. */
  hideVariantFilter?: boolean;
  /** Caller-supplied filter chips (e.g. trade overlay's source-pool
   *  filter) wrapped into the same flex-wrap row as Variant + Set so
   *  every filter affordance shares one row instead of stacking. */
  extraChips?: React.ReactNode;
}

/**
 * Persistent-state wrapper around the chip groups, driven by
 * useSelectionFilters. ListView builds the same shape against ephemeral
 * useState — see VariantChipGroup / SetChipGroup directly.
 */
export function SelectionFilterBar({ filters, hideVariantFilter, extraChips }: SelectionFilterBarProps) {
  const setSummary = useMemo(
    () => summarizeSelection(filters.selectedSets, 'All sets', setSummaryLabel),
    [filters.selectedSets],
  );

  return (
    <div className="flex items-start gap-2 flex-wrap">
      {!hideVariantFilter && (
        <VariantChipGroup
          selectedVariants={filters.selectedVariants}
          onToggle={filters.toggleVariant}
          onClear={filters.clearVariants}
        />
      )}
      <SetChipGroup
        summary={setSummary}
        selectedSets={filters.selectedSets}
        onToggleSet={filters.toggleSet}
        onSelectGroup={filters.replaceGroup}
        onClear={filters.clearSets}
      />
      {extraChips}
    </div>
  );
}
