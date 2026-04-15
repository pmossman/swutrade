import { test, expect } from '@playwright/test';

// URL-encoded share link with one want (Luke Skywalker - Hero of Yavin,
// Hyperspace-restricted via mask=4=bit2) and one available card pinned
// to a known JTL Hyperspace productId. Round-trips a full Phase-1
// share without depending on app state from a previous test.
const SHARE_URL =
  '/?w=jump-to-lightspeed%3A%3Aluke-skywalker-hero-of-yavin.2.r4&a=622133.3';

test.describe('Shared list URL roundtrip', () => {
  test('?w= / ?a= URL lands on the /list view with rendered rows', async ({ page }) => {
    await page.goto(SHARE_URL);

    await expect(page.getByRole('button', { name: 'Start a trade', exact: true })).toBeVisible();
    await expect(page.getByText('SHARED LIST')).toBeVisible();

    // Wants section + the Luke row with HYPERSPACE pill.
    await expect(page.getByText('WANTS').first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('section').filter({ hasText: 'WANTS' })
        .getByText('Luke Skywalker - Hero of Yavin'),
    ).toBeVisible();

    // Available section.
    await expect(page.getByText('AVAILABLE').first()).toBeVisible();
  });

  test('Start a trade flips into trade view and lands on Offering overlay', async ({ page }) => {
    await page.goto(SHARE_URL);
    await expect(page.getByRole('button', { name: 'Start a trade', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Start a trade', exact: true }).click();

    // The view flips to trade — useTradeUrl rewrites the search params
    // (dropping view=trade) so we don't assert on the URL, only on the
    // visible chrome.
    await expect(page.getByRole('button', { name: 'Add cards to Offering' }))
      .toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Add cards to Receiving' })).toBeVisible();
  });

  test('Variant filter chip narrows the rendered list', async ({ page }) => {
    await page.goto(SHARE_URL);
    await expect(page.getByText('SHARED LIST')).toBeVisible();

    // Expand the variant chip group.
    await page.getByRole('button', { name: /Variant/i }).click();
    await expect(page.getByRole('button', { name: 'STANDARD' })).toBeVisible();

    // Tap STANDARD — Hyperspace-only want should drop out (Standard
    // doesn't overlap the Hyperspace restriction).
    await page.getByRole('button', { name: 'STANDARD' }).click();

    // Wants section's "No wants match" empty-state appears.
    await expect(page.getByText(/No wants match the current filter/i)).toBeVisible({
      timeout: 5_000,
    });
  });
});
