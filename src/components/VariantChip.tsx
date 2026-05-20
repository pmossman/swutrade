import { variantBadgeColor, variantChipLabel } from '../variants';

/**
 * Variant chip — single source of truth for the colored variant
 * pill used inside the wishlist's RestrictionEditor and the new
 * VariantSwapPopover. Extracted so a future variant-color tweak
 * lands in both surfaces simultaneously instead of drifting.
 *
 * `selected=false` dims the chip to 30% opacity (the same dim the
 * wishlist editor used) — communicates "available but not active"
 * without removing the chip from the visible set.
 *
 * `disabled` is for variants the catalog doesn't have for this
 * card family (e.g. a unit with no Prestige print). Rendered greyed
 * + non-clickable so users can see the full vocabulary but can't
 * pick something that doesn't exist.
 */
interface VariantChipProps {
  variant: string;
  selected: boolean;
  onClick?: () => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

const SIZE_CLASSES = {
  sm: 'text-[10px] leading-none px-2 py-1',
  md: 'text-xs leading-none px-3 py-2',
};

export function VariantChip({
  variant,
  selected,
  onClick,
  disabled = false,
  size = 'md',
  ariaLabel,
}: VariantChipProps) {
  const stateClasses = disabled
    ? 'opacity-20 cursor-not-allowed'
    : selected
      ? ''
      : 'opacity-30 hover:opacity-60';
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={ariaLabel ?? `${variantChipLabel(variant)}${selected ? ' (selected)' : ''}`}
      className={`${SIZE_CLASSES[size]} rounded font-medium transition-opacity ${variantBadgeColor(variant)} ${stateClasses}`}
    >
      {variantChipLabel(variant)}
    </button>
  );
}
