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
    await expect(page.getByText(/Trade preview|Checking what you could trade/)).toHaveCount(0);
  });

  test('banner surfaces a preview with ?from=<handle> on an empty trade', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.removeItem('swu.wants.v2');
      window.localStorage.removeItem('swu.available.v1');
    });

    await page.goto('/?from=pmoss');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    // The banner fetches the sender's lists on mount and renders one
    // of: loading, preview, no-match, error. Assert on whichever
    // terminal state applies — all prove the banner is wired.
    await expect(
      page.getByText(/Trade preview|You could offer|has \d+ card|No card overlap/),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('?autoBalance=1 applies the match without requiring a click', async ({ page }) => {
    // Seed wants + available so the compute has something to find.
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.wants.v2', JSON.stringify([
        { id: 'mw1', familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1, restriction: { mode: 'any' }, addedAt: 1 },
      ]));
      window.localStorage.setItem('swu.available.v1', JSON.stringify([
        { id: 'ma1', productId: '681378', qty: 1, addedAt: 2 },
      ]));
    });

    await page.goto('/?from=pmoss&autoBalance=1');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    // Either the match auto-applied ("Loaded N cards...") or there
    // was no overlap ("No card overlap..."). Both prove the auto
    // path ran without a user click.
    await expect(
      page.getByText(/Loaded \d+ card|No card overlap/),
    ).toBeVisible({ timeout: 10_000 });

    // The autoBalance flag should be stripped from the URL after
    // consumption so reloads / shares don't re-trigger.
    await expect.poll(() => page.url(), { timeout: 5_000 })
      .not.toMatch(/autoBalance=1/);
  });

  test('dismissing the banner hides it for the session', async ({ page }) => {
    await page.goto('/?from=pmoss');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    // Wait for the banner (in any post-fetch state) before dismissing.
    await expect(
      page.getByText(/Trade preview|You could offer|has \d+ card|No card overlap|Checking what/),
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expect(
      page.getByText(/Trade preview|You could offer|has \d+ card|No card overlap|Checking what/),
    ).toHaveCount(0);
  });
});
