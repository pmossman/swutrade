import type { Page } from '@playwright/test';

/**
 * Opens the My Lists drawer. "Open my lists" used to be a top-level
 * button in the header; it now lives inside the account menu popover,
 * so specs that need to exercise list-drawer flows go through the
 * two-click path here.
 *
 * Works in both signed-in and signed-out states — the account menu
 * exposes My Lists in both popover variants since lists are stored
 * client-side until cloud sync is opted into.
 */
export async function openMyLists(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'My Lists' }).click();
}
