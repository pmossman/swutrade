import { test, expect } from '@playwright/test';
import { signIn, createIsolatedUser, ensureTestUser, cleanupTestUser, type TestUser } from './helpers/auth';

test.describe('Trade history save', () => {
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

  test('Save button appears on trade summary for signed-in users and saves successfully', async ({ page }) => {
    await page.goto('/?y=622133.1&t=681378.1&pct=80&pm=m');

    // Wait for BOTH card data AND auth to resolve before opening summary.
    await expect(page.getByText('Luke Skywalker').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(user.username).first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Open trade summary' }).click();

    const saveBtn = page.getByRole('button', { name: 'Save this trade' });
    await expect(saveBtn).toBeVisible({ timeout: 10_000 });
    await saveBtn.click();

    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 10_000 });

    const trades = await page.evaluate(async () => {
      const res = await fetch('/api/trades');
      return res.json();
    });
    expect(trades.length).toBeGreaterThan(0);
  });
});
