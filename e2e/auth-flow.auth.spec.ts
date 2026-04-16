import { test, expect } from '@playwright/test';
import { signIn, createIsolatedUser, ensureTestUser, cleanupTestUser, type TestUser } from './helpers/auth';

test.describe('Authenticated state', () => {
  // Serial within this describe — shared `user` variable.
  test.describe.configure({ mode: 'serial' });
  let user: TestUser;

  test.beforeEach(async ({ context }) => {
    user = createIsolatedUser();
    await ensureTestUser(user);
    await signIn(context, user);
  });

  test.afterEach(async () => {
    await cleanupTestUser(user);
  });

  test('header shows username when signed in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(user.username)).toBeVisible({ timeout: 10_000 });
  });

  test('signing out clears the session', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(user.username)).toBeVisible({ timeout: 10_000 });

    // New account-menu flow: tap the avatar pill opens a popover
    // instead of logging out immediately (the old behavior was a
    // papercut — one accidental tap killed the session). Sign out
    // lives inside the popover.
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();

    // Logout does a fetch then clears React state — may take a moment.
    await expect(page.getByRole('button', { name: /Sign in/i })).toBeVisible({ timeout: 10_000 });
  });
});
