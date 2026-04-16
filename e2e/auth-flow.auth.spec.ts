import { test, expect } from '@playwright/test';
import { signIn, TEST_USER } from './helpers/auth';

test.describe('Authenticated state', () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test('header shows username when signed in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });
  });

  test('signing out clears the session', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    await page.getByText(TEST_USER.username).click();

    // After logout, Sign in button should reappear.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 5_000 });
  });
});
