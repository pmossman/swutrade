import { expect, type Page } from '@playwright/test';

/**
 * Wait until the app is loaded in a signed-in state. The username
 * used to render inline in the header pill; after the header
 * consolidation it lives inside the account-menu popover. Specs
 * that previously used `expect(page.getByText(user.username))` as
 * a ready-gate should use this instead — the account-menu button
 * is always visible when the app has hydrated in a signed-in
 * session, and it doesn't require opening the popover to observe.
 */
export async function waitForSignedIn(page: Page, timeout = 10_000): Promise<void> {
  await expect(page.getByRole('button', { name: 'Account menu' }))
    .toBeVisible({ timeout });
}
