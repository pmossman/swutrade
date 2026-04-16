import { test, expect } from '@playwright/test';

// iPhone 14-ish viewport. Avoid devices['iPhone 14'] since it pulls
// in webkit; we only install chromium in CI.
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test.describe('Mobile viewport sanity', () => {
  test('app fits, top bar collapses to kebab, search overlay covers the viewport', async ({ page }) => {
    await page.goto('/');

    // Top bar chrome: logo + My Lists + pricing pill are primary; on
    // mobile Share / Clear fold into a single kebab ("Trade actions"),
    // but it only appears once cards are present — so just verify the
    // visible-at-idle controls.
    await expect(page.getByRole('button', { name: 'Open my lists' })).toBeVisible();
    await expect(page.getByRole('button', { name: /TCG Market/ })).toBeVisible();

    // Both trade panels render — on mobile they stack vertically.
    await expect(page.getByRole('button', { name: 'Add cards to Offering' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add cards to Receiving' })).toBeVisible();

    // Open the Offering search overlay — expect it to take over the
    // viewport (no "click-through" to the underlying trade panel).
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();
    await expect(page.getByPlaceholder('Search cards...').first()).toBeVisible();

    // Touch-only "Done" button is the mobile dismiss CTA — one per
    // side's overlay renders, match the first.
    await expect(page.getByRole('button', { name: /^Done$/ }).first()).toBeVisible();

    // The balance banner at the bottom shows in the idle state.
    await page.getByRole('button', { name: 'Close search' }).first().click();
    // With no cards, the banner says "ADD CARDS TO WEIGH THE TRADE".
    await expect(page.getByText(/ADD CARDS TO WEIGH THE TRADE/i)).toBeVisible();
  });
});
