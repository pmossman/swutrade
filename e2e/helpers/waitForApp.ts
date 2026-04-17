import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Waits until the "Loading prices…" footer indicator is gone, i.e.
 * `priceData.isAnyLoading` has flipped to false and `allCards` is
 * populated. Several features depend on this — matchmaker preview
 * compute, community source chip materialization, the trade balancer
 * math — and on a cold-started Vercel preview the 26 sequential set
 * fetches can take 15-20s, well over the default 5s expect timeout.
 *
 * Call this right after `page.goto(...)` + signed-in-visible check
 * in any auth e2e that reads from `allCards`-derived state. Uses a
 * 30s timeout because CI cold starts are the worst case; on a warm
 * preview it resolves in <100ms (the element was never visible).
 */
export async function waitForPricesLoaded(page: Page, timeout = 30_000) {
  await expect(page.getByText('Loading prices…')).not.toBeVisible({ timeout });
}
