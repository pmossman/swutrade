import { test, expect, type Page } from '@playwright/test';

/**
 * First-run tutorial coverage.
 *
 * The tour fires for signed-out users on their first visit and never
 * auto-resurfaces after dismissal. A "Show tutorial" entry in the
 * AccountMenu replays it on demand.
 *
 * Notes:
 *   - `playwright.config.ts` pre-seeds `swu.tour.dismissedAt` for
 *     every anonymous spec so existing locator clicks aren't
 *     intercepted. Every test here must explicitly CLEAR that flag
 *     via `addInitScript` before the first `goto('/')` — otherwise
 *     the tour won't activate at all.
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

test.describe('First-run tutorial', () => {
  test('shows automatically for a brand-new signed-out user', async ({ page }) => {
    await clearTourFlag(page);
    await page.goto('/');

    // Step 1: welcome (centered, no anchor).
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Balance every trade/i)).toBeVisible();
    await expect(page.getByText(/1 \/ 3/)).toBeVisible();

    // Advance to step 2: Add cards anchor.
    await page.getByRole('button', { name: /^Next$/ }).click();
    await expect(page.getByText(/Stage cards on each side/i)).toBeVisible();
    await expect(page.getByText(/2 \/ 3/)).toBeVisible();

    // Advance to step 3: Sign in finale.
    await page.getByRole('button', { name: /^Next$/ }).click();
    await expect(page.getByText(/Sign in to unlock more/i)).toBeVisible();
    await expect(page.getByText(/3 \/ 3/)).toBeVisible();

    // Finish the tour.
    await page.getByRole('button', { name: /^Got it$/ }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Dismissal is persisted; reload should NOT resurface the tour.
    const stored = await readTourFlag(page);
    expect(stored).toBeTruthy();

    await page.reload();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 3_000 });
  });

  test('Skip tour dismisses immediately and persists', async ({ page }) => {
    await clearTourFlag(page);
    await page.goto('/');

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Skip tour/i }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const stored = await readTourFlag(page);
    expect(stored).toBeTruthy();
  });

  test('suppressed on shared-session URL (QR scan) so the invite prompt has focus', async ({ page }) => {
    await clearTourFlag(page);
    // /s/<code> with a bogus code lands on the SessionView's
    // not-found state (the API returns 404 for unknown ids). What
    // we're testing is the view-mode gate, not the invite flow —
    // the not-found copy is fine as long as the tutorial doesn't
    // overlay it.
    await page.goto('/s/SUPPRESSX');

    // SessionView renders its "doesn't exist or no longer
    // available" copy, and the tutorial never mounts.
    await expect(
      page.getByText(/doesn't exist|no longer available/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Dismissal flag was NOT written — a user who later navigates
    // to the home/trade-builder surface should still see the tour.
    const stored = await readTourFlag(page);
    expect(stored).toBeNull();
  });

  test('suppressed on shared-list URL so the list view has focus', async ({ page }) => {
    await clearTourFlag(page);
    // Minimal ?w= payload — encoding doesn't matter, just needs to
    // trigger the 'list' view mode. Real shared-list URLs use
    // deflate+base64url; for suppression we only need the view
    // detection to fire.
    await page.goto('/?view=list&w=~abc');
    // ListView (or its empty fallback) mounts; no tutorial dialog.
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 3_000 });

    const stored = await readTourFlag(page);
    expect(stored).toBeNull();
  });

  test('suppressed on profile URL so the profile view has focus', async ({ page }) => {
    await clearTourFlag(page);
    await page.goto('/u/nobodyspecial');
    // ProfileView loads (either finds user or shows not-found);
    // tutorial stays hidden either way.
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 3_000 });

    const stored = await readTourFlag(page);
    expect(stored).toBeNull();
  });

  test('Replay from AccountMenu re-opens the tour after dismissal', async ({ page }) => {
    await clearTourFlag(page);
    await page.goto('/');

    // Skip first so we enter the "dismissed" state.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Skip tour/i }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Open AccountMenu → "Show tutorial".
    await page.getByRole('button', { name: /Account menu/i }).click();
    await page.getByRole('button', { name: /Show tutorial/i }).click();

    // Tour re-activates at step 1.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Balance every trade/i)).toBeVisible();
    await expect(page.getByText(/1 \/ 3/)).toBeVisible();

    // localStorage flag was cleared by the replay.
    const stored = await readTourFlag(page);
    expect(stored).toBeNull();
  });
});
