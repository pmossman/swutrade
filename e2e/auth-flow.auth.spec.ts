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
    // Header was consolidated: the username no longer renders inline in
    // the top bar (it used to sit beside the avatar on desktop-width
    // viewports). It lives inside the account-menu popover now, so
    // verifying the signed-in state means opening the menu.
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Account menu' }).click();
    // On desktop viewports the username renders twice — once inline in
    // the account-menu trigger (hidden sm:inline) and once as the
    // popover header. Either match is fine for "signed in"; pin the
    // locator so strict mode doesn't reject the 2-element resolution.
    await expect(page.getByText(user.username).first()).toBeVisible({ timeout: 10_000 });
  });

  test('signing out clears the session', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 });

    // New account-menu flow: tap the avatar pill opens a popover
    // instead of logging out immediately (the old behavior was a
    // papercut — one accidental tap killed the session). Sign out
    // lives inside the popover, as does the username identity line.
    await page.getByRole('button', { name: 'Account menu' }).click();
    // On desktop viewports the username renders twice — once inline in
    // the account-menu trigger (hidden sm:inline) and once as the
    // popover header. Either match is fine for "signed in"; pin the
    // locator so strict mode doesn't reject the 2-element resolution.
    await expect(page.getByText(user.username).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Sign out' }).click();

    // Logout does a fetch then clears React state — may take a moment.
    // After sign-out the account menu button is still "Account menu"
    // (signed-out anon-avatar variant uses the same label).
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 });
  });
});
