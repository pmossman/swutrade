import { test, expect } from '@playwright/test';
import {
  signIn,
  createIsolatedUser,
  ensureTestUser,
  cleanupTestUser,
  createSenderFixture,
  type TestUser,
} from './helpers/auth';
import { installBotInGuild, createGuildMembership } from './helpers/guilds';

/**
 * Multi-user Phase 4 smoke: when viewer + sender are enrolled (with
 * rollups on) in the same bot-installed guild, and their wants/
 * available overlap, the "Community wants" chip surfaces in the
 * Offering picker. Exercises the full path:
 *   /api/me/community rollup query
 *   → useCommunityCards client fetch
 *   → TradeSide source-chip materialization
 * without mocking anything below the browser.
 */
test.describe('Community source chip', () => {
  // Serial: describe-scoped `viewer`, `sender`, and `cleanups` would
  // race under fullyParallel between the two tests below and
  // cross-contaminate each other's DB fixtures.
  test.describe.configure({ mode: 'serial' });

  let viewer: TestUser;
  let sender: Awaited<ReturnType<typeof createSenderFixture>>;
  const cleanups: Array<() => Promise<void>> = [];

  test.beforeEach(async ({ context }) => {
    viewer = createIsolatedUser();
    await ensureTestUser(viewer);
    await signIn(context, viewer);

    sender = await createSenderFixture({
      // Sender wants a Luke family; viewer will seed an available
      // card in that same family below so the chip has something to
      // surface.
      wants: [{ familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1 }],
    });

    const guildId = `community-${viewer.userId}`;
    cleanups.push(await installBotInGuild(guildId, { guildName: 'Community Test Guild' }));
    cleanups.push(await createGuildMembership(viewer.userId, guildId, {
      enrolled: true,
      includeInRollups: true,
      appearInQueries: true,
    }));
    cleanups.push(await createGuildMembership(sender.userId, guildId, {
      enrolled: true,
      includeInRollups: true,
      appearInQueries: true,
    }));
  });

  test.afterEach(async () => {
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
    await sender.cleanup();
    await cleanupTestUser(viewer);
  });

  test('"Community wants" chip appears in the Offering picker when a mutual guild member wants a card the viewer has available', async ({ page }) => {
    // Seed the viewer's available list via localStorage — the app
    // reads from there on mount for anonymous + first-sign-in paths.
    // productId 617180 = Luke JTL Standard, which is in the family
    // the sender wants.
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.available.v1', JSON.stringify([
        { id: 'va1', productId: '617180', qty: 1, addedAt: Date.now() },
      ]));
    });

    await page.goto('/');
    await expect(page.getByText(viewer.username)).toBeVisible({ timeout: 10_000 });

    // Open the Offering picker.
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();

    // Chip is visible + qty-annotated. Label is "Community wants N"
    // where N reflects the count of matching available cards.
    await expect(
      page.getByRole('button', { name: /Community wants \d+/ }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('chip does not appear when the viewer is not enrolled in any guild', async ({ page }) => {
    // Undo the viewer's enrollment — chip should drop out.
    const { getDb } = await import('../lib/db.js');
    const { userGuildMemberships } = await import('../lib/schema.js');
    const { eq } = await import('drizzle-orm');
    const db = getDb();
    await db.delete(userGuildMemberships).where(eq(userGuildMemberships.userId, viewer.userId));

    await page.addInitScript(() => {
      window.localStorage.setItem('swu.available.v1', JSON.stringify([
        { id: 'va1', productId: '617180', qty: 1, addedAt: Date.now() },
      ]));
    });

    await page.goto('/');
    await expect(page.getByText(viewer.username)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();

    await expect(
      page.getByRole('button', { name: /Community wants/ }),
    ).toHaveCount(0);
  });
});
