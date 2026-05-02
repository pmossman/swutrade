/**
 * Renders an ISO timestamp as a relative time-ago string, falling
 * back to the local date string after 30 days.
 *
 * Single helper across the app. Five reimplementations existed
 * before with three different fallback thresholds (7d / 30d /
 * never), so the same event rendered as "5d ago" / "Apr 26" /
 * "4/26/2026, 3:14:22 PM" depending on the view it surfaced in.
 * Audit 14-domain-rendering F4 + 10-ux-primitives.md.
 *
 * 30 days was chosen as the fallback threshold because it matches
 * what TradeDetailView + HomeView (the most-time-spent views)
 * already did. NaN-safe — returns an empty string for unparseable
 * input rather than `Invalid Date`.
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}
