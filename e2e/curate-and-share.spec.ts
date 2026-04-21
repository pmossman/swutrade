import { test, expect } from '@playwright/test';
import { openMyLists } from './helpers/openMyLists';

// Pinned productId against the current cached dataset. Stable enough —
// TCGPlayer reassigning productIds is rare, and e2e runs weekly-cached
// data so a reassignment shows up loudly in a single red test.
const LUKE_JTL_HYPERSPACE = '622133';

// Drawer picker tiles are labeled `Add <displayName> <badgeText> to list`
// — displayName has no trailing "(variant)" suffix (variant lives in
// the badge text). Trade-side search tiles use CardTile with its own
// "Add <name> (<variant>) to trade" shape, but we don't need those
// here.
const LUKE_ANY = /Add Luke Skywalker - Hero of Yavin.*to list/i;
const LUKE_HYPERSPACE = /Add Luke Skywalker - Hero of Yavin.*Hyperspace.*to list/i;

test.describe('Curator: build lists and share', () => {
  test.beforeEach(async ({ context }) => {
    // Grant clipboard access so the Copy-link assertion can read it back.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('add a restricted want + an available, then the Share link encodes both', async ({ page }) => {
    await page.goto('/');

    // Open the Lists drawer. All subsequent interactions are scoped
    // inside the dialog, since the two trade-side overlays are also
    // rendered (hidden) in the DOM and carry the same accessible
    // names (Search input, Variant button, etc.).
    await openMyLists(page);
    const dialog = page.getByRole('dialog', { name: 'MY LISTS' });
    await expect(dialog).toBeVisible();
    // Wait for Radix Dialog mount animation to settle — on slow CI runners
    // the portal's content can detach mid-click during the animation.
    await dialog.getByRole('tab', { name: /^wishlist/i }).waitFor({ state: 'attached' });

    // --- Wants: Hyperspace-only restriction ---------------------------------
    await dialog.getByRole('tab', { name: /^wishlist/i }).click();
    await dialog.getByRole('button', { name: /add card/i }).click();

    // Open the variant filter, pick Hyperspace.
    await dialog.getByRole('button', { name: /Variant/i }).click();
    await dialog.getByRole('button', { name: 'HYPERSPACE' }).click();

    // Type to narrow the grid to Luke Skywalker - Hero of Yavin, then tap.
    await dialog.getByPlaceholder('Search cards...').fill('jtl luke');
    const lukeWantsTile = dialog.getByRole('button', { name: LUKE_ANY }).first();
    await expect(lukeWantsTile).toBeVisible({ timeout: 5_000 });
    await lukeWantsTile.click();

    // Back to the wants list — row should show the Hyperspace restriction.
    await dialog.getByRole('button', { name: /Back to list/i }).click();
    await expect(dialog.getByRole('button', { name: 'Only Hyperspace' })).toBeVisible();

    // --- Available: exact productId ----------------------------------------
    await dialog.getByRole('tab', { name: /^trade binder/i }).click();
    await dialog.getByRole('button', { name: /add card/i }).click();

    await dialog.getByPlaceholder('Search cards...').fill('jtl luke hyperspace');
    const lukeAvailTile = dialog.getByRole('button', { name: LUKE_HYPERSPACE }).first();
    await expect(lukeAvailTile).toBeVisible({ timeout: 5_000 });
    await lukeAvailTile.click();

    await dialog.getByRole('button', { name: /Back to list/i }).click();
    await expect(
      dialog.getByRole('tabpanel', { name: /trade binder/i })
        .getByText('Luke Skywalker - Hero of Yavin'),
    ).toBeVisible();

    // --- Share: copy link encodes both sides -------------------------------
    await dialog.getByRole('button', { name: 'Share lists' }).click();
    // Copy-link lives in a popover portal — outside the dialog scope.
    await page.getByRole('button', { name: 'Copy link' }).click();

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('?');
    // Both w= and a= params present (compressed; values start with ~).
    expect(clip).toMatch(/[?&]w=/);
    expect(clip).toMatch(/[?&]a=/);
    // Round-trip: visit the copied URL and verify the list view renders
    // the same items we built. This is the strongest assertion because
    // it exercises both the encoder (share popover) and the decoder
    // (page load) end-to-end — independent of internal format.
    await page.goto(clip);
    await expect(page.getByText('SHARED LIST')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Luke Skywalker - Hero of Yavin').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('dedup by (familyId + restriction): Hyperspace-only and Any-variant for the same card create TWO rows', async ({ page }) => {
    await page.goto('/');
    await openMyLists(page);
    const dialog = page.getByRole('dialog', { name: 'MY LISTS' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: /^wishlist/i }).waitFor({ state: 'attached' });

    await dialog.getByRole('tab', { name: /^wishlist/i }).click();

    // --- First add: no variant filter → restriction = any ------------------
    await dialog.getByRole('button', { name: /add card/i }).click();
    await dialog.getByPlaceholder('Search cards...').fill('jtl luke');
    await dialog.getByRole('button', { name: LUKE_ANY }).first().click();
    await dialog.getByRole('button', { name: /Back to list/i }).click();
    await expect(dialog.getByRole('button', { name: 'Any variant' })).toBeVisible();

    // --- Second add: Hyperspace-only restriction ---------------------------
    await dialog.getByRole('button', { name: /add card/i }).click();
    await dialog.getByRole('button', { name: /Variant/i }).click();
    await dialog.getByRole('button', { name: 'HYPERSPACE' }).click();
    await dialog.getByPlaceholder('Search cards...').fill('jtl luke');
    await dialog.getByRole('button', { name: LUKE_ANY }).first().click();
    await dialog.getByRole('button', { name: /Back to list/i }).click();

    // Two distinct restriction labels: "Any variant" and "Only Hyperspace".
    await expect(dialog.getByRole('button', { name: 'Any variant' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Only Hyperspace' })).toBeVisible();

    // Each row renders its own Remove button — total two.
    await expect(
      dialog.getByRole('tabpanel', { name: /wishlist/i })
        .getByRole('button', { name: 'Remove' }),
    ).toHaveCount(2);
  });
});
