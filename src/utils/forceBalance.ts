export type BalanceTier = 'empty' | 'balanced' | 'ripple' | 'disturbance' | 'chaos';
export type BalanceFavored = 'none' | 'you' | 'them';
export type BalanceTone = 'neutral' | 'good' | 'warn' | 'bad';

export interface BalanceState {
  tier: BalanceTier;
  favored: BalanceFavored;
  diff: number;
  absDiff: number;
  ratio: number;
  headline: string;
  subline?: string;
  tone: BalanceTone;
}

const BALANCED_RATIO = 0.02;
const RIPPLE_RATIO = 0.07;
const DISTURBANCE_RATIO = 0.15;
const EVEN_EPSILON = 0.01;

// Absolute-dollar floors — a small gap shouldn't escalate to alarm-tier
// language even if the ratio is high. A $2 gap on a $5 trade is 40%
// ratio-wise but nobody cares; the swu-title-level "great disturbance"
// framing is reserved for trades where the dollar gap itself is meaningful.
const RIPPLE_DOLLAR_FLOOR = 5;       // below $5 can't exceed "ripple"
const DISTURBANCE_DOLLAR_FLOOR = 15; // below $15 can't exceed "disturbance"

export function computeBalance(
  yourTotal: number,
  theirTotal: number,
  isEmpty: boolean,
): BalanceState {
  if (isEmpty) {
    return {
      tier: 'empty',
      favored: 'none',
      diff: 0,
      absDiff: 0,
      ratio: 0,
      // Plain, quiet label instead of a CTA-looking headline. In
      // propose mode this bar sits next to the ProposeBar's own
      // gold-tinted chrome and the two fighting for attention was
      // confusing — this just reads as a section header, not an
      // action.
      headline: 'Trade balance',
      tone: 'neutral',
    };
  }

  const diff = yourTotal - theirTotal;
  const absDiff = Math.abs(diff);
  const larger = Math.max(yourTotal, theirTotal);
  const ratio = larger > 0 ? absDiff / larger : 0;
  // If "your" side (Offering) is worth MORE, you're giving more than
  // you're getting — the trade tilts toward THEM. Inverted from the
  // raw diff sign because "your total" is what you're giving up.
  const favored: BalanceFavored = absDiff < EVEN_EPSILON ? 'none' : diff > 0 ? 'them' : 'you';
  const favoredPossessive = favored === 'you' ? 'your' : 'their';
  const pctText = `${(ratio * 100).toFixed(1)}%`;
  const gapSubline =
    favored === 'none'
      ? undefined
      : `$${absDiff.toFixed(2)} in ${favoredPossessive} favor · ${pctText} skew`;

  // Compute the ratio-based tier first, then clamp by absolute-dollar
  // floors so small-total trades can't escalate into alarm territory.
  let tier: BalanceTier;
  if (absDiff < EVEN_EPSILON || ratio < BALANCED_RATIO) {
    tier = 'balanced';
  } else if (ratio < RIPPLE_RATIO) {
    tier = 'ripple';
  } else if (ratio < DISTURBANCE_RATIO) {
    tier = 'disturbance';
  } else {
    tier = 'chaos';
  }

  if (absDiff < RIPPLE_DOLLAR_FLOOR && (tier === 'disturbance' || tier === 'chaos')) {
    tier = 'ripple';
  } else if (absDiff < DISTURBANCE_DOLLAR_FLOOR && tier === 'chaos') {
    tier = 'disturbance';
  }

  switch (tier) {
    case 'balanced':
      return {
        tier, favored, diff, absDiff, ratio,
        headline: 'Balance in the Force',
        subline: gapSubline,
        tone: 'good',
      };
    case 'ripple':
      return {
        tier, favored, diff, absDiff, ratio,
        headline: 'A ripple in the Force',
        subline: gapSubline,
        tone: 'neutral',
      };
    case 'disturbance':
      return {
        tier, favored, diff, absDiff, ratio,
        headline: 'A disturbance in the Force',
        subline: gapSubline,
        tone: 'warn',
      };
    case 'chaos':
      return {
        tier, favored, diff, absDiff, ratio,
        headline: 'A great disturbance in the Force',
        subline: gapSubline,
        tone: 'bad',
      };
  }
}

export interface BalanceChrome {
  border: string;
  bg: string;
  headline: string;
  subline: string;
  glow: string;
}

export function balanceChrome(tone: BalanceTone): BalanceChrome {
  switch (tone) {
    case 'good':
      // Balance headline colors deliberately avoid emerald/blue — those
      // are reserved as side-identity colors (Offering / Receiving) so
      // the balance line never visually collides with a side.
      return {
        border: 'border-gold-bright/40',
        bg: 'bg-gold/5',
        headline: 'text-gold-bright',
        subline: 'text-gold/70',
        glow: 'shadow-glow-gold',
      };
    case 'warn':
      return {
        border: 'border-amber-500/40',
        bg: 'bg-amber-950/30',
        headline: 'text-amber-300',
        subline: 'text-amber-400/70',
        glow: 'shadow-glow-amber',
      };
    case 'bad':
      return {
        border: 'border-crimson/50',
        bg: 'bg-crimson-deep/30',
        headline: 'text-crimson-light',
        subline: 'text-crimson-light/70',
        glow: 'shadow-glow-crimson',
      };
    case 'neutral':
    default:
      return {
        border: 'border-gold/30',
        bg: 'bg-space-800',
        headline: 'text-gold',
        subline: 'text-gold/60',
        glow: 'shadow-glow-gold',
      };
  }
}
