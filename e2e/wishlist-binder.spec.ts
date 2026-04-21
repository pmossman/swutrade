import { test, expect, type Page } from '@playwright/test';

/**
 * Smoke coverage for the dedicated Wishlist + Binder views (the
 * 2026-04-21 split). Both views live at `?view=wishlist` /
 * `?view=binder` and are the canonical edit surfaces for each list;
 * the `ListsDrawer` is retained only as an in-trade-builder quick-
 * edit sidebar.
 *
 * Scope: navigate → header renders → panel renders → picker reachable
 * from the footer. Deep editing flows (priority toggle, variant
 * restriction editor, qty stepper) stay covered by `drawer.spec.ts`
 * since the shared `WantsPanel` / `AvailablePanel` components
 * underlie both surfaces.
 */

const LUKE_FAMILY = 'jump-to-lightspeed::luke-skywalker-hero-of-yavin';

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

test.describe('Dedicated Wishlist view', () => {
  test('?view=wishlist renders the page chrome + seeded rows', async ({ page }) => {
    await seedLists(page);
    await page.goto('/?view=wishlist');

    // Breadcrumb in the AppHeader — "Home › Wishlist".
    await expect(
      page.getByRole('link', { name: /Home/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Page heading + counts.
    await expect(page.getByRole('heading', { name: /Your wishlist/i })).toBeVisible();
    // Seeded row.
    await expect(page.getByText('Luke Skywalker - Hero of Yavin')).toBeVisible({ timeout: 10_000 });

    // Footer Add Card affordance — same label the drawer's Wants tab
    // uses, since both surfaces render the shared WantsPanel.
    await expect(page.getByRole('button', { name: /Add Card/i })).toBeVisible();
  });

  test('empty-state copy surfaces when the wishlist is empty', async ({ page }) => {
    // No init script — wishlist starts empty.
    await page.goto('/?view=wishlist');
    await expect(page.getByText(/Your wishlist is empty/i)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Dedicated Binder view', () => {
  test('?view=binder renders the page chrome + seeded rows', async ({ page }) => {
    await seedLists(page);
    await page.goto('/?view=binder');

    await expect(page.getByRole('heading', { name: /Your trade binder/i })).toBeVisible();
    // Seeded available row — productId 622133 = Luke Skywalker
    // (Hyperspace). Resolved by byProductId in AvailablePanel.
    await expect(page.getByText(/Luke Skywalker/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Add Card/i })).toBeVisible();
  });

  test('empty-state copy surfaces when the binder is empty', async ({ page }) => {
    await page.goto('/?view=binder');
    await expect(page.getByText(/Your trade binder is empty/i)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Home → dedicated view routing', () => {
  test('NavMenu "My Wishlist" + "My Binder" entries route to the views', async ({ page }) => {
    await page.goto('/');

    // Hamburger → My Wishlist routes to ?view=wishlist.
    await page.getByRole('button', { name: 'Navigation menu' }).click();
    await page.getByRole('link', { name: 'My Wishlist' }).click();
    await expect(page).toHaveURL(/view=wishlist/);
    await expect(page.getByRole('heading', { name: /Your wishlist/i })).toBeVisible({ timeout: 10_000 });

    // Same for My Trade Binder.
    await page.getByRole('button', { name: 'Navigation menu' }).click();
    await page.getByRole('link', { name: 'My Trade Binder' }).click();
    await expect(page).toHaveURL(/view=binder/);
    await expect(page.getByRole('heading', { name: /Your trade binder/i })).toBeVisible({ timeout: 10_000 });
  });
});
