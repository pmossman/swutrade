import { test, expect } from '@playwright/test';
import { signIn } from './helpers/auth';

test.describe('Trade history save', () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test('Save button appears on trade summary for signed-in users and saves successfully', async ({ page }) => {
    // Load a pre-built trade via URL.
    await page.goto('/?y=622133.1&t=681378.1&pct=80&pm=m');
    await expect(page.getByText('Luke Skywalker').first()).toBeVisible({ timeout: 10_000 });

    // Open the trade summary.
    await page.getByRole('button', { name: 'Open trade summary' }).click();

    // Save button should be visible (signed in).
    const saveBtn = page.getByRole('button', { name: 'Save this trade' });
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
    await saveBtn.click();

    // Should transition to "Saved" state.
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 5_000 });

    // Verify via API that the trade is in the DB.
    const trades = await page.evaluate(async () => {
      const res = await fetch('/api/trades');
      return res.json();
    });
    expect(trades.length).toBeGreaterThan(0);
  });
});
