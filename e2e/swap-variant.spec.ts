import { test, expect } from '@playwright/test';

// Pre-load a single Luke Hyperspace into the binder via localStorage —
// the binder hook reads from `swu.available.v1` on mount, so this
// short-circuits the catalog-load race that a URL-param seed would
// otherwise hit (the trade view's `useTradeUrl` decode only fires
// once `allLoadedCards` is populated).
const SEED = `
  window.localStorage.setItem(
    'swu.available.v1',
    JSON.stringify([{ id: 'a1', productId: '622133', qty: 1, addedAt: 2 }])
  );
`;

test.describe('Swap variant (in-place popover)', () => {
  test('binder row variant pill opens popover; tapping a chip swaps in place', async ({ page }) => {
    // Use the dedicated binder view — the swap affordance lives on
    // every row with `familyCandidates`, which AvailablePanel
    // supplies from the CardIndex context.
    await page.addInitScript(SEED);
    await page.goto('/?view=binder');

    // The seeded row renders by displayName (variant-suffix stripped).
    await expect(page.getByText('Luke Skywalker - Hero of Yavin').first())
      .toBeVisible({ timeout: 10_000 });

    // The swap trigger's aria-label encodes the current variant —
    // "currently Hyperspace" before the swap.
    const swapTrigger = page.getByRole('button', {
      name: /Swap variant — currently Hyperspace/i,
    });
    await expect(swapTrigger).toBeVisible();
    await swapTrigger.click();

    // Popover surfaces every print variant in the family as a chip.
    // Tap Standard to swap (it's the canonical first-listed variant
    // and exists for almost every card).
    const standardChip = page.getByRole('button', { name: /^Standard/i }).last();
    await expect(standardChip).toBeVisible({ timeout: 3_000 });
    await standardChip.click();

    // Row title still shows the same base name (it's a swap, not a
    // removal); the trigger's aria-label flips to the new variant,
    // confirming the swap took.
    await expect(page.getByText('Luke Skywalker - Hero of Yavin').first()).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Swap variant — currently Standard/i }),
    ).toBeVisible({ timeout: 3_000 });

    // Only one binder row for this card — the swap replaced rather
    // than duplicated (the old "search overlay seeded with basename"
    // antipattern would have produced two rows).
    await expect(page.getByText('Luke Skywalker - Hero of Yavin')).toHaveCount(1);
  });
});
