interface ChipProps {
  active: boolean;
  onClick: () => void;
  /** Optional palette override — variant chips use the variant-badge
   *  color, set chips use a gold tint, etc. Falls back to a neutral
   *  space-700 when omitted. */
  colorClass?: string;
  children: React.ReactNode;
}

/**
 * Pill toggle used inside every filter popover (variant, set, show,
 * rarity, sort). Visually flat: active = full color, inactive = 30%
 * opacity with a transparent border. Caller owns selection state.
 */
export function Chip({ active, onClick, colorClass, children }: ChipProps) {
  const base = 'text-[10px] leading-none px-2 py-1 rounded font-bold uppercase tracking-wide transition-opacity border';
  const activeClasses = colorClass ?? 'bg-space-700 text-gray-200 border-space-600';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} ${activeClasses} ${active ? '' : 'opacity-30 border-transparent'}`}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
