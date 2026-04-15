import { test, expect } from '@playwright/test';

test.describe('Swap variant kebab flow', () => {
  test('opens search overlay seeded with basename + finds other variants', async ({ page }) => {
    // Pre-load a Hyperspace Luke Skywalker into the trade so we can
    // exercise Swap variant on a known row.
    await page.goto('/?y=622133.1&pct=80&pm=m');

    await expect(page.getByText('Luke Skywalker - Hero of Yavin').first()).toBeVisible({
      timeout: 10_000,
    });

    // Open the row's More-actions kebab.
    await page.getByRole('button', { name: 'More actions' }).first().click();

    // Pick Swap variant.
    await page.getByRole('menuitem', { name: 'Swap variant' }).click();

    // Search overlay seeded with the basename — Standard + Showcase
    // variants should render alongside the in-trade Hyperspace tile.
    // Regression for the parseQuery slug-alias bug: "of" in the seeded
    // query previously routed the search to ATE.
    await expect(page.getByRole('button', { name: /Luke Skywalker - Hero of Yavin \(Standard\)/i }))
      .toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /Luke Skywalker - Hero of Yavin \(Showcase\)/i }))
      .toBeVisible();
  });
});
