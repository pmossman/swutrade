import { test, expect } from '@playwright/test';

/*
 * Smoke tests for Phase 1a-1d exit criteria that don't require
 * /api/* (since `vite dev` doesn't serve the serverless functions).
 * Full API-backed e2e lives behind `vercel dev` in CI and isn't
 * wired up yet.
 */

test.describe('Shell (tabs + routing)', () => {
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
});

test.describe('Trades FAB (create-open failure path)', () => {
  test('Retry banner surfaces when the server is unreachable', async ({ page }) => {
    // Under `vite dev` there's no /api/sessions/create-open; the
    // dev server serves index.html for unmatched routes, apiPost's
    // JSON parse throws, and the route catches + shows the banner.
    // Covers sub-phase 1d exit criterion "create-open failure
    // handling" (design §10).
    await page.goto('/');
    await page.getByRole('button', { name: 'Start trade' }).click();

    const banner = page.getByRole('alert');
    await expect(banner).toBeVisible();
    await expect(banner.getByText(/couldn't start a trade/i)).toBeVisible();
    await expect(banner.getByRole('button', { name: /retry/i })).toBeVisible();
  });
});

test.describe('Trade canvas (unknown code)', () => {
  test('/s/<bogus> renders the Trade-not-found state', async ({ page }) => {
    await page.goto('/s/BOGUS123');
    await expect(
      page.getByRole('heading', { name: /trade not found/i }),
    ).toBeVisible();
    // Tab bar hides on standalone routes.
    await expect(page.getByRole('tablist', { name: /primary/i })).toBeHidden();
  });
});

test.describe('Cards tab (ghost state)', () => {
  test('signed-out user sees the sign-in CTA on the Cards tab', async ({ page }) => {
    // /api/auth/me returns index.html under vite dev → useAuth
    // resolves to user=null, isLoading=false → ghost branch renders.
    await page.goto('/cards');
    await expect(
      page.getByRole('heading', { name: /sign in to keep a list/i }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /continue with discord/i })).toBeVisible();
  });
});
