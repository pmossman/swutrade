import { test, expect, type Page } from '@playwright/test';

/**
 * Opt-in tutorial coverage.
 *
 * The tour does NOT auto-fire — auto-firing on first visit was too
 * aggressive in practice. Instead, AppHeader renders a glowing help
 * button when `tutorial.hasBeenSeen` is false; clicking it invokes
 * `tutorial.replay()` which starts the tour. After dismissal the
 * help button hides itself (the AccountMenu's "Show tutorial" entry
 * remains as the tucked-away access point for users who want to
 * revisit).
 *
 * Notes:
 *   - `playwright.config.ts` pre-seeds `swu.tour.dismissedAt` for
 *     every anonymous spec to keep existing locator clicks unblocked.
 *     Tests here that exercise the first-time-visitor path must
 *     explicitly CLEAR the flag via `addInitScript` before goto.
 *   - We anchor assertions to copy strings from `src/tutorial/steps.ts`.
 *     If those strings change, update both files together.
 */

const STORAGE_KEY = 'swu.tour.dismissedAt';

async function clearTourFlag(page: Page) {
  await page.addInitScript((key) => {
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  }, STORAGE_KEY);
}

async function readTourFlag(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
}

test.describe('Opt-in tutorial', () => {
  test('does NOT auto-fire on first visit; help button is glowing instead', async ({ page }) => {
    await clearTourFlag(page);
    await page.goto('/');

    // No tour overlay on first paint — that's the whole change.
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 3_000 });

    // Glowing help button visible in the AppHeader.
    const helpBtn = page.getByRole('button', { name: 'Show tutorial' });
    await expect(helpBtn).toBeVisible({ timeout: 5_000 });

    // No localStorage flag was written — the user hasn't engaged yet.
    const stored = await readTourFlag(page);
    expect(stored).toBeNull();
  });

  test('clicking help button opens the tour; finishing hides the button', async ({ page }) => {
    await clearTourFlag(page);
    await page.goto('/');

    const helpBtn = page.getByRole('button', { name: 'Show tutorial' });
    await expect(helpBtn).toBeVisible({ timeout: 5_000 });
    await helpBtn.click();

    // Step 1: welcome (centered, no anchor).
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Balance every trade/i)).toBeVisible();
    await expect(page.getByText(/1 \/ 3/)).toBeVisible();

    // Advance through the rest.
    await page.getByRole('button', { name: /^Next$/ }).click();
    await expect(page.getByText(/2 \/ 3/)).toBeVisible();
    await page.getByRole('button', { name: /^Next$/ }).click();
    await expect(page.getByText(/3 \/ 3/)).toBeVisible();

    // Finish.
    await page.getByRole('button', { name: /^Got it$/ }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Help button tucks itself away after dismissal.
    await expect(page.getByRole('button', { name: 'Show tutorial' })).toHaveCount(0);

    // Dismissal is persisted to localStorage so the help button stays
    // hidden on a reload. (Reload assertion deliberately omitted —
    // `clearTourFlag` uses `addInitScript` which fires on every nav,
    // so testing reload-persistence here would fight the test setup.
    // The storage-flag assertion below is the meaningful check.)
    const stored = await readTourFlag(page);
    expect(stored).toBeTruthy();
  });

  test('Skip dismisses + hides the help button', async ({ page }) => {
    await clearTourFlag(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Show tutorial' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: /Skip tour/i }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show tutorial' })).toHaveCount(0);

    const stored = await readTourFlag(page);
    expect(stored).toBeTruthy();
  });

  test('AccountMenu replay still works after dismissal (tucked-away access)', async ({ page }) => {
    await clearTourFlag(page);
    await page.goto('/');

    // Run through once + skip so we're in the dismissed state.
    await page.getByRole('button', { name: 'Show tutorial' }).click();
    await page.getByRole('button', { name: /Skip tour/i }).click();
    await expect(page.getByRole('button', { name: 'Show tutorial' })).toHaveCount(0);

    // AccountMenu still has the replay entry. The help button + this
    // menu entry both bind to `tutorial.replay()`; both must work.
    await page.getByRole('button', { name: /Account menu/i }).click();
    await page.getByRole('button', { name: /Show tutorial/i }).click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Balance every trade/i)).toBeVisible();
    await expect(page.getByText(/1 \/ 3/)).toBeVisible();

    // Replay also clears the dismissed flag — the help button reappears
    // until the user dismisses again.
    const stored = await readTourFlag(page);
    expect(stored).toBeNull();
  });
});
