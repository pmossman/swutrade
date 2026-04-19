import { test, expect } from '@playwright/test';

test.describe('Profile view', () => {
  test('renders a user profile with public wants via ?profile= param', async ({ page }) => {
    // Use the e2e-test user seeded by globalSetup (has public wants).
    await page.goto('/?profile=e2e-test');

    // Profile header. Scope the handle match to <main> — the AppHeader
    // breadcrumb also renders `@e2e-test` as the current-page crumb
    // when viewing your own profile, so an un-scoped locator matches
    // both and trips Playwright's strict-mode check.
    await expect(page.getByText('E2E Test User')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('main').getByText('@e2e-test', { exact: true })).toBeVisible();

    // Start a trade CTA — the primary action now lives in the profile
    // hero inside <main> (it was moved out of <header> to free up
    // breadcrumb space; see the header-separation slice).
    await expect(page.getByRole('main').getByRole('button', { name: 'Start a trade' })).toBeVisible();
  });

  test('shows error for non-existent profile', async ({ page }) => {
    await page.goto('/?profile=definitely-not-a-real-user-zzz');
    await expect(page.getByText('User not found')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Back to SWUTrade')).toBeVisible();
  });
});
