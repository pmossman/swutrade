import { variantBadgeColor, variantDisplayLabel } from '../variants';

// Short hover explainers — help new players (and non-players stumbling
// onto a shared trade) decode the alphabet soup of SWU print variants
// without having to leave the page. Title-attribute hovers are the
// cheapest path; a proper tooltip component can come later.
const VARIANT_HINTS: Record<string, string> = {
  'Hyperspace': 'Hyperspace — alternate-art print run; more collectible than Standard.',
  'Hyperspace Foil': 'Hyperspace Foil — foil treatment of the Hyperspace alt-art. Rarer + pricier.',
  'Foil': 'Foil — foil treatment of the Standard print.',
  'Showcase': 'Showcase — premium alternate-art variant with decorative frame.',
  'Prestige': 'Prestige — ultra-rare alternate printing (typically leader cards).',
  'Prestige Foil': 'Prestige Foil — foil version of the Prestige variant.',
  'Serialized': 'Serialized — numbered print run; one of the scarcest variants.',
  'Gold': 'Gold — limited convention/event variant.',
  'Regional': 'Regional — tournament-exclusive variant.',
};

export type VariantBadgeSize = 'xs' | 'sm';

interface VariantBadgeProps {
  variant: string;
  /**
   * `sm` (default) reads at 9px — the size used by trade rows and
   * shared-list rows. `xs` is 8px for tighter surfaces (drawer rows,
   * trade-summary lines).
   */
  size?: VariantBadgeSize;
  /** Add `shrink-0` so flex parents can't compress the pill below the
   *  text width. Use inside the trade row, where set/qty siblings
   *  compete for space. */
  shrink?: boolean;
  /** Escape hatch for callers that need to apply layout-only utilities
   *  (e.g. truncation inside a fixed-width column). Avoid using this
   *  to override visual chrome — that's what variantBadgeColor owns. */
  className?: string;
}

const SIZE_CLASSES: Record<VariantBadgeSize, string> = {
  xs: 'text-[8px] px-1 py-0.5',
  sm: 'text-[9px] px-1 py-0.5',
};

/**
 * Colored pill identifying a card's print variant — the visual ground
 * truth for "this row is Hyperspace / Showcase / Regional / Gold / etc."
 *
 * Standard cards render nothing: the label is the implicit baseline,
 * and a "STD" pill on every row would be noise. Callers don't need to
 * guard with `variantDisplayLabel(variant)` themselves — pass the
 * variant straight in and the component handles the empty case.
 */
export function VariantBadge({
  variant,
  size = 'sm',
  shrink = false,
  className = '',
}: VariantBadgeProps) {
  const label = variantDisplayLabel(variant);
  if (!label) return null;
  return (
    <span
      title={VARIANT_HINTS[variant]}
      className={[
        SIZE_CLASSES[size],
        'leading-none rounded font-bold uppercase tracking-wide',
        variantBadgeColor(variant),
        shrink ? 'shrink-0' : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      {label}
    </span>
  );
}
