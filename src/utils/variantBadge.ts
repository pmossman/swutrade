// Canonical display order for SWU print variants. Lower = earlier.
// Any unknown variant sinks to the bottom of the list so it's visible
// but doesn't muddle the established progression.
const VARIANT_ORDER: Record<string, number> = {
  'Standard': 0,
  'Foil': 1,
  'Hyperspace': 2,
  'Hyperspace Foil': 3,
  'Prestige': 4,
  'Prestige Foil': 5,
  'Serialized': 6,
  // Showcase always last
  'Showcase': 99,
};

export function variantRank(label: string): number {
  // Unknown variants sort just before Showcase (so Showcase stays last)
  // but after all the known-ordered variants.
  return VARIANT_ORDER[label] ?? 50;
}

// Display label tuned for narrow surfaces. Most variants fit at their
// full name; only "Hyperspace Foil" is long enough to need an
// abbreviation. Standard returns an empty string since it's the
// implicit baseline — callers should skip rendering the badge for it.
const VARIANT_DISPLAY: Record<string, string> = {
  'Standard': '',
  'Hyperspace Foil': 'Hyper Foil',
};

export function variantDisplayLabel(label: string): string {
  if (label in VARIANT_DISPLAY) return VARIANT_DISPLAY[label];
  return label;
}

// Small colored pills for card print variants — reused by the search
// results and the enriched trade-row view. Keep these purely chromatic;
// they shouldn't collide with side-identity colors (emerald/blue) used
// by Offering / Receiving panels.
export function variantBadgeColor(variant: string): string {
  switch (variant) {
    case 'Standard':        return 'bg-gray-600/50 text-gray-300';
    case 'Hyperspace':      return 'bg-sky-900/50 text-sky-300';
    case 'Hyperspace Foil': return 'bg-purple-900/50 text-purple-300';
    case 'Showcase':        return 'bg-amber-900/50 text-amber-300';
    case 'Prestige':        return 'bg-fuchsia-900/50 text-fuchsia-300';
    case 'Prestige Foil':   return 'bg-pink-900/50 text-pink-300';
    case 'Serialized':      return 'bg-gold/20 text-gold';
    case 'Foil':            return 'bg-indigo-900/50 text-indigo-300';
    default:                return 'bg-space-600 text-gray-300';
  }
}
