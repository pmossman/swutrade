import { test, expect } from '@playwright/test';

test.describe('Trending cards', () => {
  test('trending section appears in the search overlay when browsing', async ({ page }) => {
    await page.goto('/');

    // Open the Offering search overlay.
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();

    // Trending section should appear above the browse grid (visible
    // only when no query typed and no source chips active). It fetches
    // from /api/trending which aggregates public wants across users.
    // In the test DB we have at least the seeded e2e-test user +
    // pmoss, so there should be at least one trending card.
    await expect(page.getByText('TRENDING')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Most wanted by the community')).toBeVisible();

    // Typing a query should hide the trending section.
    await page.getByPlaceholder('Search cards...').first().fill('luke');
    await expect(page.getByText('TRENDING')).not.toBeVisible({ timeout: 3_000 });
  });
});
