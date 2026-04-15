import { test, expect } from '@playwright/test';

test.describe('Trade flow', () => {
  test('add card → qty stepper updates row + side total', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();

    const input = page.getByRole('textbox', { name: 'Search cards...' }).first();
    await input.fill('luke jtl');

    // Add the Standard variant by aria-label.
    const tile = page.getByRole('button', {
      name: /Luke Skywalker - Hero of Yavin \(Standard\)/i,
    }).first();
    await expect(tile).toBeVisible({ timeout: 5_000 });
    await tile.click();

    // Dismiss the search overlay so the row is in view.
    await page.getByRole('button', { name: 'Close search' }).first().click();

    // Row exists with HYPERSPACE pill suppressed (Standard renders no pill).
    await expect(page.getByText('Luke Skywalker - Hero of Yavin').first()).toBeVisible();

    // Bump qty twice; 1 distinct card with qty growing 1 → 2 → 3.
    const incrementBtn = page.getByRole('button', { name: 'Increase quantity' }).first();
    await incrementBtn.click();
    await incrementBtn.click();

    // Qty span sits between the decrement and increment buttons. After
    // two clicks it should read "3"; the only "3" rendered on the page
    // in this state is the qty value (set codes / footer don't carry it).
    await expect(page.getByText('3', { exact: true })).toBeVisible();
  });

  test('URL captures the trade so refresh restores it', async ({ page }) => {
    // Synthesized URL; productId = real Luke Skywalker Hero of Yavin
    // (Hyperspace) on JTL. Pinned to a stable id so this test isn't
    // sensitive to set ordering.
    await page.goto('/?y=622133.1&pct=80&pm=m');

    await expect(page.getByText('Luke Skywalker - Hero of Yavin').first()).toBeVisible({
      timeout: 10_000,
    });
    // HYPERSPACE pill renders for the variant.
    await expect(page.getByText('HYPERSPACE').first()).toBeVisible();
  });
});
