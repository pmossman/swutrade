import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Waits until `allCards` is populated. Uses the *positive* footer
 * signal "Prices updated Xm ago" — renders when `priceTimestamp`
 * is set AND `isAnyLoading` is false — so a falsy check on
 * "Loading prices…" can't race past the initial state where
 * loadAllSets hasn't even fired yet.
 *
 * Several features require `allCards` before they produce visible
 * DOM: matchmaker preview compute, community chip, card picker
 * grid. Prices are served from static `/data/*.json` files via
 * Vercel's CDN, so this resolves in a few seconds max on fresh
 * deploys, sub-second on warm previews.
 */
export async function waitForPricesLoaded(page: Page, timeout = 15_000) {
  await expect(page.getByText(/Prices updated/)).toBeVisible({ timeout });
}
