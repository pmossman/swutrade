import type { Page } from '@playwright/test';

/**
 * Opens the My Lists drawer. "Open my lists" started as a top-level
 * header button, then moved into the AccountMenu popover, and now
 * lives in the NavMenu (hamburger) popover — the AccountMenu was slim-
 * med to identity actions only. Specs that exercise list-drawer flows
 * go through the two-click path here.
 *
 * Works in both signed-in and signed-out states — NavMenu exposes
 * "My Lists" in both variants since lists are stored client-side
 * until cloud sync is opted into.
 */
export async function openMyLists(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Navigation menu' }).click();
  await page.getByRole('button', { name: 'My Lists' }).click();
}
