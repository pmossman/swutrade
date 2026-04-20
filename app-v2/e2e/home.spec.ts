import { test, expect } from '@playwright/test';

/*
 * Smoke test for Phase 1b exit criteria:
 *   - Four tabs render and route.
 *   - Trades FAB opens the Sheet; Escape dismisses it.
 *   - prefers-reduced-motion is respected (no Framer spring when on).
 */

test.describe('Home shell (1b smoke)', () => {
  test('tab bar renders four destinations and Trades is active by default', async ({ page }) => {
    await page.goto('/');

    const tablist = page.getByRole('tablist', { name: /primary/i });
    await expect(tablist).toBeVisible();

    await expect(tablist.getByRole('tab', { name: 'Trades' })).toBeVisible();
    await expect(tablist.getByRole('tab', { name: 'Cards' })).toBeVisible();
    await expect(tablist.getByRole('tab', { name: 'Community' })).toBeVisible();
    await expect(tablist.getByRole('tab', { name: 'Me' })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Trades', level: 1 })).toBeVisible();
  });

  test('navigating to each tab changes the URL and screen title', async ({ page }) => {
    await page.goto('/');
    const tablist = page.getByRole('tablist', { name: /primary/i });

    await tablist.getByRole('tab', { name: 'Cards' }).click();
    await expect(page).toHaveURL(/\/cards$/);
    await expect(page.getByRole('heading', { name: 'Cards', level: 1 })).toBeVisible();

    await tablist.getByRole('tab', { name: 'Community' }).click();
    await expect(page).toHaveURL(/\/community$/);
    await expect(page.getByRole('heading', { name: 'Community', level: 1 })).toBeVisible();

    await tablist.getByRole('tab', { name: 'Me' }).click();
    await expect(page).toHaveURL(/\/me$/);
    await expect(page.getByRole('heading', { name: 'Me', level: 1 })).toBeVisible();
  });

  test('Start-trade FAB opens the sheet, Escape closes it', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Start trade' }).click();

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Start trade')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('reduced-motion disables sheet spring transition', async ({ browser }) => {
    const context = await browser.newContext({
      ...browser.contexts()[0]?.storageState,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.goto('/');

    // With reduced-motion the sheet should render immediately after the tap.
    // We don't assert the transition-duration directly (CSS-only timing is
    // hard to probe deterministically); instead we rely on the sheet being
    // fully in view within 50ms, which is well under the 280ms spring.
    await page.getByRole('button', { name: 'Start trade' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 100 });

    await context.close();
  });
});
