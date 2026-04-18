import { test, expect } from '@playwright/test';

// iPhone 14-ish viewport. isMobile + hasTouch are Chromium-only —
// skip this spec on Firefox/WebKit via the project filter.
test.skip(({ browserName }) => browserName !== 'chromium', 'Mobile emulation is Chromium-only');

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test.describe('Mobile viewport sanity', () => {
  test('app fits, top bar collapses to kebab, search overlay covers the viewport', async ({ page }) => {
    await page.goto('/');

    // Top bar chrome at idle: logo + account menu + view toggle.
    // My Lists was lifted into the account menu popover, so the
    // guaranteed-visible control at idle is the account menu button.
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();

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
    // With no cards, the empty headline now reads "Trade balance"
    // (quieted from the previous "ADD CARDS TO WEIGH THE TRADE" CTA,
    // which was competing with the ProposeBar in propose mode).
    await expect(page.getByText(/^Trade balance$/i)).toBeVisible();
  });
});
