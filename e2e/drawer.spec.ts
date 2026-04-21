import { test, expect, type Page } from '@playwright/test';
import { openMyLists } from './helpers/openMyLists';

// Family id for Luke Skywalker - Hero of Yavin (JTL). Matches what
// `cardFamilyId` produces at runtime.
const LUKE_FAMILY = 'jump-to-lightspeed::luke-skywalker-hero-of-yavin';

// Seed a wants list (Any variant, qty 2) + an available list (qty 1)
// before the app mounts so the drawer opens with rows already present.
async function seedLists(page: Page) {
  await page.addInitScript((fam) => {
    window.localStorage.setItem('swu.wants.v2', JSON.stringify([
      { id: 'w1', familyId: fam, qty: 2, restriction: { mode: 'any' }, addedAt: 1 },
    ]));
    window.localStorage.setItem('swu.available.v1', JSON.stringify([
      { id: 'a1', productId: '622133', qty: 1, addedAt: 2 },
    ]));
  }, LUKE_FAMILY);
}

test.describe('Lists drawer interactions', () => {
  test('switch tabs, edit restriction, toggle priority, remove', async ({ page }) => {
    await seedLists(page);
    await page.goto('/');

    // Open the drawer. Scope all interactions to the dialog since the
    // trade overlays are also in the DOM with similar aria-labels.
    await openMyLists(page);
    const dialog = page.getByRole('dialog', { name: 'MY LISTS' });
    await expect(dialog).toBeVisible();

    // Wishlist tab is selected by default; row visible with "Any variant".
    // Tab labels were reconciled to user-facing vocabulary ("Wishlist" /
    // "Trade binder") in the 2026-04-21 split; internal values stay
    // `wants` / `available`.
    const wantsTab = dialog.getByRole('tab', { name: /^wishlist/i });
    await expect(wantsTab).toHaveAttribute('data-state', 'active');
    const wantsPanel = dialog.getByRole('tabpanel', { name: /wishlist/i });
    await expect(wantsPanel.getByText('Luke Skywalker - Hero of Yavin')).toBeVisible({
      timeout: 10_000,
    });
    await expect(dialog.getByRole('button', { name: 'Any variant' })).toBeVisible();

    // --- Restriction editor: flip to Specific → Hyperspace ----------------
    await dialog.getByRole('button', { name: 'Any variant' }).click();
    await dialog.getByRole('button', { name: 'Specific' }).click();
    // Editor pre-selects Standard; tap Hyperspace to add it as a
    // second allowed variant.
    await dialog.getByRole('button', { name: 'Hyperspace', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close variant editor' }).click();
    // Row's restriction label now reflects both Standard + Hyperspace.
    await expect(
      dialog.getByRole('button', { name: /Standard or Hyperspace|Hyperspace or Standard|2 variants/ }),
    ).toBeVisible();

    // --- Priority toggle: aria-label flips --------------------------------
    await dialog.getByRole('button', { name: 'Mark as priority' }).click();
    await expect(dialog.getByRole('button', { name: 'Unmark as priority' })).toBeVisible();

    // --- Trade binder tab: seeded row visible, can be removed ----------------
    await dialog.getByRole('tab', { name: /^trade binder/i }).click();
    const availPanel = dialog.getByRole('tabpanel', { name: /trade binder/i });
    await expect(availPanel.getByText('Luke Skywalker - Hero of Yavin')).toBeVisible();
    await availPanel.getByRole('button', { name: 'Remove' }).click();
    await expect(availPanel.getByText('Your trade binder is empty')).toBeVisible();
  });
});
