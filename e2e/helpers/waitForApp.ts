import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Waits until `allCards` is populated. Uses the *positive* footer
 * signal "Prices updated Xm ago" — which only renders when
 * `priceData.priceTimestamp` is set AND `isAnyLoading` is false — so
 * a falsy check on "Loading prices…" can't race past the initial
 * state where loadAllSets hasn't even fired yet.
 *
 * Several features require `allCards` to be loaded before they
 * produce visible DOM: matchmaker banner preview compute, community
 * source chip materialization, card picker grid. Call this right
 * after `page.goto(...)` + the signed-in-visible check in any auth
 * e2e that reads `allCards`-derived state.
 *
 * 45s timeout budgets for Vercel cold starts (26 sequential
 * `/api/prices/[set]` fetches at ~1-2s each on first invocation).
 * On a warm preview it resolves in <100ms.
 */
export async function waitForPricesLoaded(page: Page, timeout = 45_000) {
  await expect(page.getByText(/Prices updated/)).toBeVisible({ timeout });
}
