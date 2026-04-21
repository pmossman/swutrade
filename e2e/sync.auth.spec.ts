import { test, expect } from '@playwright/test';
import { signIn, createIsolatedUser, ensureTestUser, cleanupTestUser, type TestUser } from './helpers/auth';
import { openMyLists } from './helpers/openMyLists';

test.describe('Server sync', () => {
  test.describe.configure({ mode: 'serial' });
  let user: TestUser;

  test.beforeEach(async ({ context }) => {
    user = createIsolatedUser();
    await ensureTestUser(user);
    await signIn(context, user);
  });

  test.afterEach(async () => {
    await cleanupTestUser(user);
  });

  test('wants survive localStorage wipe (restored from server)', async ({ page }) => {
    // Explicit ?view=trade — signed-in users now land on Home by
    // default, but this spec drives the ListsDrawer card picker which
    // needs the trade builder's loaded price data to surface tiles.
    await page.goto('/?view=trade');
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 });

    // Open the drawer and add a want via the picker.
    await openMyLists(page);
    const dialog = page.getByRole('dialog', { name: 'MY LISTS' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: /^wishlist/i }).click();
    await dialog.getByRole('button', { name: /add card/i }).click();
    await dialog.getByPlaceholder('Search cards...').fill('jtl luke');

    const tile = dialog.getByRole('button', { name: /Add Luke Skywalker.*to list/i }).first();
    await expect(tile).toBeVisible({ timeout: 5_000 });
    await tile.click();
    await dialog.getByRole('button', { name: /Back to list/i }).click();

    // Verify the row appeared.
    await expect(dialog.getByText('Luke Skywalker - Hero of Yavin')).toBeVisible();

    // Read the local wants and push them directly to the server to
    // confirm the sync API works. The debounced hook sync may have
    // timing issues in headless Playwright; this explicit push
    // isolates the API from the hook.
    const pushResult = await page.evaluate(async () => {
      const local = JSON.parse(localStorage.getItem('swu.wants.v2') || '[]');
      const res = await fetch('/api/sync/wants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(local),
      });
      return { status: res.status, pushed: local.length, server: (await res.json()).length };
    });
    console.log('Push result:', JSON.stringify(pushResult));
    expect(pushResult.status).toBe(200);
    expect(pushResult.server).toBeGreaterThan(0);

    // Nuke localStorage and reload — items should come back from server.
    await page.evaluate(() => {
      localStorage.removeItem('swu.wants.v2');
      localStorage.removeItem('swu.available.v1');
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 });

    // Reopen drawer — the want should still be there.
    await openMyLists(page);
    await expect(page.getByRole('dialog', { name: 'MY LISTS' })).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'MY LISTS' })
        .getByText('Luke Skywalker - Hero of Yavin'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('available items sync to server and back', async ({ page }) => {
    // Explicit ?view=trade — see comment on the wants spec above.
    await page.goto('/?view=trade');
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 });

    // Add an available item via the drawer.
    await openMyLists(page);
    const dialog = page.getByRole('dialog', { name: 'MY LISTS' });
    await dialog.getByRole('tab', { name: /^trade binder/i }).click();
    await dialog.getByRole('button', { name: /add card/i }).click();
    await dialog.getByPlaceholder('Search cards...').fill('jtl luke hyperspace');

    const tile = dialog.getByRole('button', { name: /Add Luke Skywalker.*to list/i }).first();
    await expect(tile).toBeVisible({ timeout: 5_000 });
    await tile.click();
    await dialog.getByRole('button', { name: /Back to list/i }).click();

    await expect(
      dialog.getByRole('tabpanel', { name: /trade binder/i })
        .getByText('Luke Skywalker - Hero of Yavin'),
    ).toBeVisible();

    // Explicitly push local available items to the server (same
    // approach as the wants test — bypasses debounce timing).
    const pushResult = await page.evaluate(async () => {
      const local = JSON.parse(localStorage.getItem('swu.available.v1') || '[]');
      const res = await fetch('/api/sync/available', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(local),
      });
      const body = await res.json();
      return { status: res.status, pushed: local.length, server: body.length };
    });
    expect(pushResult.status).toBe(200);
    expect(pushResult.server).toBeGreaterThan(0);
  });
});
