import { test, expect } from '@playwright/test';

// Share URL encoding:
//   w = familyId . qty . rHEXMASK      (r4 = Hyperspace only)
//   a = productId . qty
// Using Luke Skywalker - Hero of Yavin (JTL):
//   - wants: Hyperspace-only, qty 2
//   - available: Luke (Standard), qty 3
const LUKE_FAMILY_URL_ENCODED = 'jump-to-lightspeed%3A%3Aluke-skywalker-hero-of-yavin';
const LUKE_JTL_STANDARD = '617180';
const LUKE_JTL_HYPERSPACE = '622133';
const SHARE_URL =
  `/?w=${LUKE_FAMILY_URL_ENCODED}.2.r4&a=${LUKE_JTL_STANDARD}.3`;

test.describe('Recipient: end-to-end trade from a shared link', () => {
  test('shared-link landing → Start trade → They want chip active → add to Offering', async ({ page }) => {
    await page.goto(SHARE_URL);

    // Land on the /list view.
    await expect(page.getByText('SHARED LIST')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Start a trade', exact: true })).toBeVisible();

    // Start a trade — flips into trade mode with Offering's overlay
    // auto-open and the "They want" source chip pre-activated.
    await page.getByRole('button', { name: 'Start a trade', exact: true }).click();

    // The Offering overlay is open — "Adding to Offering" header is visible.
    const addingTo = page.getByText('Adding to', { exact: false }).first();
    await expect(addingTo).toBeVisible({ timeout: 5_000 });

    // After the picker unification, source chips render inline in a
    // visible row above the filter bar (no more collapsed summary).
    // "They want" should be visible + active as a result of the
    // shared-list landing's auto-activation seed.
    await expect(
      page.getByRole('button', { name: /They want \d+/, pressed: true }),
    ).toBeVisible();

    // The grid should be scoped to the sender's wants — Luke
    // Skywalker - Hero of Yavin (Hyperspace) is the best-match rep
    // for the sender's restriction.
    // Tile aria-label doubles the variant for non-Standard cards.
    const lukeTile = page.getByRole('button', {
      name: /Luke Skywalker - Hero of Yavin.*Hyperspace.*to trade/i,
    }).first();
    await expect(lukeTile).toBeVisible({ timeout: 5_000 });
    await lukeTile.click();

    // Close overlay and verify the card landed in the Offering row.
    await page.getByRole('button', { name: 'Close search' }).first().click();

    // One row in the Offering panel with the HYPERSPACE variant pill.
    await expect(page.getByText('Luke Skywalker - Hero of Yavin').first()).toBeVisible();
    await expect(page.getByText('HYPERSPACE').first()).toBeVisible();

    // URL picks up the new Offering card (may take a tick to sync).
    await expect(page).toHaveURL(new RegExp(`y=${LUKE_JTL_HYPERSPACE}\\.1`), { timeout: 10_000 });
  });
});

test.describe('Source chip is qty-aware', () => {
  test('adds the only available card → chip disappears on reopen', async ({ page }) => {
    // Seed one available item before the app boots.
    await page.addInitScript((pid) => {
      window.localStorage.setItem('swu.available.v1', JSON.stringify([
        { id: 'a1', productId: pid, qty: 1, addedAt: Date.now() },
      ]));
    }, LUKE_JTL_HYPERSPACE);

    await page.goto('/');

    // Open the Offering search overlay.
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();

    // Source chips live inside a collapsed "Show" filter alongside
    // Variant + Set. With no auto-activated chip the filter starts
    // closed — expand it to access "My available". Filter button
    // name = "Show All" (label + summary, no chips active);
    // anchored match dodges the page-level "Show tutorial" button.
    // Both sides' overlays mount simultaneously so `.first()` pins
    // to the open Offering side.
    await page.getByRole('button', { name: /^Show All\b/ }).first().click();
    const mineChip = page.getByRole('button', { name: 'My available 1' }).first();
    await expect(mineChip).toBeVisible();

    // Activate it to scope the grid to the user's available pool.
    await mineChip.click();
    // Tile aria-label doubles the variant for non-Standard cards.
    const lukeTile = page.getByRole('button', {
      name: /Luke Skywalker - Hero of Yavin.*Hyperspace.*to trade/i,
    }).first();
    await expect(lukeTile).toBeVisible({ timeout: 5_000 });
    await lukeTile.click();

    // Close and reopen the overlay — chip should no longer be visible
    // because the only available card is now fully committed to the trade.
    await page.getByRole('button', { name: 'Close search' }).first().click();
    await page.getByRole('button', { name: /Add card/ }).first().click();

    await expect(page.getByRole('button', { name: /My available/ })).toHaveCount(0);
  });
});
