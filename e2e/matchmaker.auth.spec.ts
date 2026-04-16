import { test, expect } from '@playwright/test';
import { signIn, TEST_USER } from './helpers/auth';

test.describe('Auto-balance banner (context-aware matchmaker)', () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test('banner does not appear without ?from= context', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    // No ?from= in the URL means no auto-balance prompt — the banner
    // only shows when there's a target sender to match against.
    await expect(page.getByText(/Auto-balance a trade with/)).toHaveCount(0);
  });

  test('banner appears with ?from=<handle> on an empty trade', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.removeItem('swu.wants.v2');
      window.localStorage.removeItem('swu.available.v1');
    });

    await page.goto('/?from=pmoss');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText(/Auto-balance a trade with.*@pmoss/),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Auto-balance' })).toBeVisible();
  });

  test('clicking Auto-balance attempts the match', async ({ page }) => {
    // Seed wants + available so the matchmaker has something to score.
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.wants.v2', JSON.stringify([
        { id: 'mw1', familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1, restriction: { mode: 'any' }, addedAt: 1 },
      ]));
      window.localStorage.setItem('swu.available.v1', JSON.stringify([
        { id: 'ma1', productId: '681378', qty: 1, addedAt: 2 },
      ]));
    });

    await page.goto('/?from=pmoss');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Auto-balance' }).click();

    // Either the match succeeds and we see "Loaded N card(s)..." or
    // there's no overlap — both states prove the matchmaker ran.
    await expect(
      page.getByText(/Loaded \d+ card|No card overlap/),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('dismissing the banner hides it for the session', async ({ page }) => {
    await page.goto('/?from=pmoss');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    const banner = page.getByText(/Auto-balance a trade with/);
    await expect(banner).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expect(banner).toHaveCount(0);
  });
});
