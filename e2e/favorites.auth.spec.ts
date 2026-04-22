import { test, expect } from '@playwright/test';
import { signIn, createIsolatedUser, ensureTestUser, cleanupTestUser, type TestUser } from './helpers/auth';

/**
 * End-to-end coverage for the Favorites / Trading Partners slice.
 *
 * Flow: sign in as Alice, visit Bob's profile, tap the bookmark
 * toggle, navigate home, assert the Partners module surfaces Bob,
 * tap "Trade" → lands on the trade builder pre-filled with Bob as
 * counterpart. Also exercises the remove-toggle path on re-visit.
 *
 * Doesn't exercise:
 *   - HandlePickerDialog integration (deferred per scope)
 *   - Multi-partner sort / cap behavior (covered in unit tests)
 *   - Partner sharing between devices (server round-trip is the
 *     unit test's concern; here we only verify UI wiring)
 */
test.describe('Favorites / trading partners', () => {
  test.describe.configure({ mode: 'serial' });
  let alice: TestUser;
  let bob: TestUser;

  test.beforeEach(async ({ context }) => {
    alice = createIsolatedUser();
    bob = createIsolatedUser();
    await ensureTestUser(alice);
    await ensureTestUser(bob);
    await signIn(context, alice);
  });

  test.afterEach(async () => {
    await cleanupTestUser(alice);
    await cleanupTestUser(bob);
  });

  test('add from profile → appears on Home → click Trade → lands in composer', async ({ page }) => {
    // Visit Bob's profile first.
    await page.goto(`/u/${bob.handle}`);

    // Bookmark toggle — starts unfavorited (no pressed state).
    const bookmark = page.getByRole('button', {
      name: new RegExp(`Add @${bob.handle} to your trading partners`, 'i'),
    });
    await expect(bookmark).toBeVisible({ timeout: 10_000 });
    await expect(bookmark).toHaveAttribute('aria-pressed', 'false');
    await bookmark.click();

    // After click, aria-pressed flips; the label swaps to "Remove".
    await expect(
      page.getByRole('button', {
        name: new RegExp(`Remove @${bob.handle} from your trading partners`, 'i'),
      }),
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });

    // Navigate to Home — the Partners module renders Bob.
    await page.goto('/');
    const partnersModule = page.getByRole('region', { name: /your trading partners/i });
    await expect(partnersModule).toBeVisible({ timeout: 10_000 });
    await expect(partnersModule.getByText(`@${bob.handle}`).first()).toBeVisible();

    // "Trade" button per-row → trade builder with Bob pre-filled as
    // counterpart (from=... intent query key).
    await partnersModule.getByRole('button', { name: 'Trade' }).click();
    await expect(page).toHaveURL(new RegExp(`from=${bob.handle}`), { timeout: 10_000 });
  });

  test('own profile surfaces a "Copy invite link" button', async ({ page, context }) => {
    // Signed-in viewer lands on their own profile — the Copy-invite
    // affordance is what powers the "share a trade-with-me URL via
    // Discord DM" workflow for friends in no shared bot-enabled server.
    // Button only renders on own profile, absent on someone else's.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/u/${alice.handle}`);

    const copyBtn = page.getByRole('button', { name: /Copy invite link/i });
    await expect(copyBtn).toBeVisible({ timeout: 10_000 });
    await copyBtn.click();
    await expect(page.getByRole('button', { name: /Copied ✓/ })).toBeVisible({ timeout: 5_000 });

    // Assert clipboard has the expected URL shape (relative path in
    // case the base URL varies between local dev and preview CI).
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toMatch(new RegExp(`[?&]propose=${alice.handle}`));

    // Visiting someone else's profile should NOT show the button.
    await page.goto(`/u/${bob.handle}`);
    await expect(page.getByRole('button', { name: /Copy invite link/i })).toHaveCount(0);
  });

  test('remove from profile → Home module empty again', async ({ page }) => {
    // Add first via profile → Home sanity check → remove → Home empty.
    await page.goto(`/u/${bob.handle}`);
    await page.getByRole('button', {
      name: new RegExp(`Add @${bob.handle} to your trading partners`, 'i'),
    }).click();
    await expect(
      page.getByRole('button', {
        name: new RegExp(`Remove @${bob.handle} from your trading partners`, 'i'),
      }),
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });

    // Remove via the same toggle (now in "remove" mode).
    await page.getByRole('button', {
      name: new RegExp(`Remove @${bob.handle} from your trading partners`, 'i'),
    }).click();
    await expect(
      page.getByRole('button', {
        name: new RegExp(`Add @${bob.handle} to your trading partners`, 'i'),
      }),
    ).toHaveAttribute('aria-pressed', 'false', { timeout: 5_000 });

    // Home module shows the empty-state copy instead of Bob's row.
    await page.goto('/');
    const partnersModule = page.getByRole('region', { name: /your trading partners/i });
    await expect(partnersModule).toBeVisible({ timeout: 10_000 });
    await expect(partnersModule.getByText(/Bookmark trading partners/i)).toBeVisible();
    await expect(partnersModule.getByText(`@${bob.handle}`)).toHaveCount(0);
  });
});
