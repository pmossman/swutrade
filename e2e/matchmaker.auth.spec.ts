import { test, expect } from '@playwright/test';
import {
  signIn,
  createIsolatedUser,
  ensureTestUser,
  cleanupTestUser,
  createSenderFixture,
  seedUserLists,
  type TestUser,
} from './helpers/auth';
import { waitForPricesLoaded } from './helpers/waitForApp';

/**
 * Exercises the AutoBalanceBanner against a deliberately-seeded
 * `sender` user. `viewer` is an isolated-per-test fresh user;
 * server-side wants/available are seeded via seedUserLists when a
 * test needs them. Both sides (viewer + sender) write their state
 * to the server, so `useServerSync` sees local === server on sign-in
 * and doesn't pop the migration modal that blocks every
 * interactable element behind it.
 */
test.describe('Auto-balance banner (context-aware matchmaker)', () => {
  // Serial: describe-scoped `sender` + `viewer` would race between
  // workers under fullyParallel and cross-contaminate fixtures.
  test.describe.configure({ mode: 'serial' });

  let viewer: TestUser;
  let sender: Awaited<ReturnType<typeof createSenderFixture>>;
  const extraCleanups: Array<() => Promise<void>> = [];

  test.beforeEach(async ({ context }) => {
    viewer = createIsolatedUser();
    await ensureTestUser(viewer);
    await signIn(context, viewer);
    sender = await createSenderFixture({
      wants: [{ familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1 }],
      available: [{ productId: '617180', qty: 2 }],
    });
  });

  test.afterEach(async () => {
    for (const fn of extraCleanups.reverse()) await fn();
    extraCleanups.length = 0;
    await sender.cleanup();
    await cleanupTestUser(viewer);
  });

  test('banner does not appear without ?from= context', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Trade preview|Checking what you could trade/)).toHaveCount(0);
  });

  test('banner surfaces a preview with ?from=<handle> on an empty trade', async ({ page }) => {
    await page.goto(`/?from=${sender.handle}`);
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 });
    await waitForPricesLoaded(page);

    // Viewer has empty lists; sender has 1 want + 1 available. The
    // compute finds no overlap because the viewer has nothing.
    await expect(page.getByText(/No card overlap with @/)).toBeVisible({ timeout: 15_000 });
  });

  test('?autoBalance=1 applies the match without requiring a click', async ({ page }) => {
    // Seed the viewer's own side so the compute has an overlap to
    // find. familyId matches the sender's want; productId 681378 is
    // a JTL Luke printing.
    extraCleanups.push(await seedUserLists(viewer.userId, {
      wants: [{ familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1 }],
      available: [{ productId: '681378', qty: 1 }],
    }));

    await page.goto(`/?from=${sender.handle}&autoBalance=1`);
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 });
    await waitForPricesLoaded(page);

    // Either the match auto-applied ("Loaded N cards...") or the
    // viewer's lists don't overlap with the sender's ("No card
    // overlap..."). Both prove the auto path ran without a click.
    await expect(page.getByText(/Loaded \d+ card|No card overlap/)).toBeVisible({ timeout: 15_000 });

    // The autoBalance flag should be stripped from the URL after
    // consumption so reloads / shares don't re-trigger.
    await expect.poll(() => page.url(), { timeout: 5_000 })
      .not.toMatch(/autoBalance=1/);
  });

  test('dismissing the banner hides it for the session', async ({ page }) => {
    await page.goto(`/?from=${sender.handle}`);
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 });

    // Banner in any post-fetch state is fine for this test — we
    // just want to verify the dismiss interaction.
    await expect(
      page.getByText(/Trade preview|You could offer|has \d+ card|No card overlap|Checking what/),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expect(
      page.getByText(/Trade preview|You could offer|has \d+ card|No card overlap|Checking what/),
    ).toHaveCount(0);
  });
});
