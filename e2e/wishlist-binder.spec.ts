import { test, expect, type Page } from '@playwright/test';

/**
 * Smoke coverage for the unified Collection view (the 2026-05-21 merge
 * of the previously-separate Wishlist + Trade Binder views). The view
 * lives at `?view=wishlist` / `?view=binder` — both URLs route into
 * the same `CollectionView` component with the matching tab
 * pre-selected via the `defaultTab` prop. Internal tab switches
 * update `?tab=` directly without re-triggering the routing layer.
 *
 * Scope: navigate → tab + chrome renders → panel renders → picker
 * reachable from the footer → tab switch flips the surface. Deep
 * editing flows stay covered by `drawer.spec.ts`.
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

test.describe('Collection view — Wishlist tab', () => {
  test('?view=wishlist lands on the Wishlist tab with seeded rows', async ({ page }) => {
    await seedLists(page);
    await page.goto('/?view=wishlist');

    // Breadcrumb echoes the active tab.
    await expect(
      page.getByRole('link', { name: /Home/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Wishlist tab is the active tab; Trade binder tab is inactive.
    const wishlistTab = page.getByRole('tab', { name: /Wishlist/i });
    const binderTab = page.getByRole('tab', { name: /(?:Trade )?Binder/i });
    await expect(wishlistTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
    await expect(binderTab).toHaveAttribute('aria-selected', 'false');

    // Seeded want renders.
    await expect(page.getByText('Luke Skywalker - Hero of Yavin')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Add Card/i })).toBeVisible();
  });

  test('empty-state copy surfaces when the wishlist is empty', async ({ page }) => {
    await page.goto('/?view=wishlist');
    await expect(page.getByText(/Your wishlist is empty/i)).toBeVisible({ timeout: 10_000 });
  });

  test('tab bar flips the active surface to Trade binder', async ({ page }) => {
    await seedLists(page);
    await page.goto('/?view=wishlist');

    // Seeded want visible on initial Wishlist landing.
    await expect(page.getByText('Luke Skywalker - Hero of Yavin')).toBeVisible({ timeout: 10_000 });

    // Click the Trade binder tab — same surface, different list.
    await page.getByRole('tab', { name: /(?:Trade )?Binder/i }).click();
    await expect(
      page.getByRole('tab', { name: /(?:Trade )?Binder/i }),
    ).toHaveAttribute('aria-selected', 'true');

    // URL reflects the active tab.
    await expect(page).toHaveURL(/tab=binder/);
  });
});

test.describe('Collection view — Trade binder tab', () => {
  test('?view=binder lands on the Trade binder tab with seeded rows', async ({ page }) => {
    await seedLists(page);
    await page.goto('/?view=binder');

    const binderTab = page.getByRole('tab', { name: /(?:Trade )?Binder/i });
    await expect(binderTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

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

test.describe('Home → Collection routing', () => {
  test('NavMenu "My Wishlist" + "My Trade Binder" entries land on the right tab', async ({ page }) => {
    await page.goto('/');

    // Hamburger → My Wishlist lands on the Wishlist tab.
    await page.getByRole('button', { name: 'Navigation menu' }).click();
    await page.getByRole('link', { name: 'My Wishlist' }).click();
    await expect(page).toHaveURL(/view=wishlist/);
    await expect(
      page.getByRole('tab', { name: /Wishlist/i }),
    ).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    // Same for My Trade Binder.
    await page.getByRole('button', { name: 'Navigation menu' }).click();
    await page.getByRole('link', { name: 'My Trade Binder' }).click();
    await expect(page).toHaveURL(/view=binder/);
    await expect(
      page.getByRole('tab', { name: /(?:Trade )?Binder/i }),
    ).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
  });
});
