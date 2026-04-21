import type { Page } from '@playwright/test';

/**
 * Opens the My Lists drawer (the in-trade-builder quick-edit sidebar).
 *
 * History: the entry was a top-level header button → AccountMenu → the
 * NavMenu's "My Lists" entry → this trade-builder-local "Lists" button
 * once the Wishlist / Binder split landed. NavMenu now surfaces "My
 * Wishlist" / "My Binder" which route to the dedicated views; the
 * drawer is retained only as a trade-builder quick-edit affordance
 * so users don't lose in-progress composer state to a full navigation.
 *
 * The button lives in the trade builder's action strip (top-right,
 * next to the split/tabbed toggle), labelled "Lists" on wider
 * viewports and icon-only on narrow ones. The `aria-label` is stable
 * across both so this helper is viewport-agnostic.
 */
export async function openMyLists(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Edit your wishlist or binder' }).click();
}
