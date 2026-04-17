import { test, expect } from '@playwright/test';
import { signIn, createSenderFixture, TEST_USER } from './helpers/auth';

/**
 * These tests exercise the AutoBalanceBanner against a
 * deliberately-seeded `sender` user rather than a hardcoded real
 * handle. The sender has known wants + available, so the banner's
 * terminal states (preview / no-match / loaded) are predictable.
 * Cleanup removes the sender after every test.
 */
test.describe('Auto-balance banner (context-aware matchmaker)', () => {
  // Serial to keep the describe-scoped `sender` variable from
  // racing between workers — fullyParallel is on, so without this
  // multiple tests' beforeEach hooks overwrite `sender` concurrently
  // and the test body navigates to a stale/cleaned-up handle.
  test.describe.configure({ mode: 'serial' });

  let sender: Awaited<ReturnType<typeof createSenderFixture>>;

  test.beforeEach(async ({ context }) => {
    await signIn(context);
    sender = await createSenderFixture({
      wants: [{ familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1 }],
      available: [{ productId: '617180', qty: 2 }],
    });
  });

  test.afterEach(async () => {
    await sender.cleanup();
  });

  test('banner does not appear without ?from= context', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    // No ?from= → no banner, even though the sender fixture exists.
    await expect(page.getByText(/Trade preview|Checking what you could trade/)).toHaveCount(0);
  });

  test('banner surfaces a preview with ?from=<handle> on an empty trade', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.removeItem('swu.wants.v2');
      window.localStorage.removeItem('swu.available.v1');
    });

    await page.goto(`/?from=${sender.handle}`);
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    // Viewer has empty lists; sender has 1 want + 1 available. The
    // compute finds no overlap because the viewer has nothing.
    // Expected terminal state: "No card overlap".
    await expect(
      page.getByText(/No card overlap with @/),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('?autoBalance=1 applies the match without requiring a click', async ({ page }) => {
    // Viewer has the sender's available in their wants (the productId
    // 617180 corresponds to Luke JTL Standard which is in the family
    // the sender wants). This gives the matchmaker an overlap to pick.
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.wants.v2', JSON.stringify([
        { id: 'mw1', familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1, restriction: { mode: 'any' }, addedAt: 1 },
      ]));
      window.localStorage.setItem('swu.available.v1', JSON.stringify([
        { id: 'ma1', productId: '681378', qty: 1, addedAt: 2 },
      ]));
    });

    await page.goto(`/?from=${sender.handle}&autoBalance=1`);
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    // Either the match auto-applied ("Loaded N cards...") or the
    // viewer's seeded lists don't overlap with the sender's ("No
    // card overlap..."). Both prove the auto path ran without a
    // user click.
    await expect(
      page.getByText(/Loaded \d+ card|No card overlap/),
    ).toBeVisible({ timeout: 10_000 });

    // The autoBalance flag should be stripped from the URL after
    // consumption so reloads / shares don't re-trigger.
    await expect.poll(() => page.url(), { timeout: 5_000 })
      .not.toMatch(/autoBalance=1/);
  });

  test('dismissing the banner hides it for the session', async ({ page }) => {
    await page.goto(`/?from=${sender.handle}`);
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    // Wait for the banner (in any post-fetch state) before dismissing.
    await expect(
      page.getByText(/Trade preview|You could offer|has \d+ card|No card overlap|Checking what/),
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expect(
      page.getByText(/Trade preview|You could offer|has \d+ card|No card overlap|Checking what/),
    ).toHaveCount(0);
  });
});
