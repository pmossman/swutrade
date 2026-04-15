import { test, expect } from '@playwright/test';

test.describe('App boot', () => {
  test('renders both trade panels with empty state', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/^Offering/i).first()).toBeVisible();
    await expect(page.getByText(/^Receiving/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add cards to Offering' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add cards to Receiving' })).toBeVisible();
  });

  test('emits no console errors on initial load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/');
    // Wait for initial fetches to settle.
    await expect(page.getByText(/Prices updated/)).toBeVisible({ timeout: 10_000 });
    expect(errors).toEqual([]);
  });
});
