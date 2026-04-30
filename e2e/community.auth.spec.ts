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
import { installBotInGuild, createGuildMembership } from './helpers/guilds';
import { waitForPricesLoaded } from './helpers/waitForApp';

/**
 * Multi-user Phase 4 smoke: when viewer + sender are enrolled
 * (with rollups on) in the same bot-installed guild, and their
 * wants/available overlap, the "Community wants" chip surfaces in
 * the Offering picker. Both sides seed their state server-side to
 * avoid the migration modal blocker.
 */
test.describe('Community source chip', () => {
  // Serial: describe-scoped state races between workers otherwise.
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
      // card in that same family below so the chip has something
      // to surface.
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
    // Seed the viewer's available list server-side. productId 617180
    // is Luke JTL Standard, family: jump-to-lightspeed::luke-...
    // — matches what the sender wants.
    cleanups.push(await seedUserLists(viewer.userId, {
      available: [{ productId: '617180', qty: 1 }],
    }));

    // Signed-in users now land on Home by default; pin to the trade
    // builder since that's where the Offering picker lives.
    await page.goto('/?view=trade');
    // Header consolidated — username lives behind the account menu
    // now, but all we actually care about is "signed in" so assert
    // the account menu trigger exists.
    await expect(page.getByRole('button', { name: 'Account menu' }))
      .toBeVisible({ timeout: 10_000 });
    await waitForPricesLoaded(page);

    // Open the Offering picker. Source chips live inside a collapsed
    // "Show" filter alongside Variant + Set; expand it to reveal the
    // Community wants chip.
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();
    // Filter button name = "Show All" (label + summary, no chips
    // active). Anchored match avoids the page-level "Show tutorial"
    // button. Both sides' overlays mount simultaneously, so .first()
    // pins to the Offering side.
    await page.getByRole('button', { name: /^Show All\b/ }).first().click();

    // Chip is visible + qty-annotated. Label is "Community wants N".
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

    cleanups.push(await seedUserLists(viewer.userId, {
      available: [{ productId: '617180', qty: 1 }],
    }));

    await page.goto('/?view=trade');
    await expect(page.getByRole('button', { name: 'Account menu' }))
      .toBeVisible({ timeout: 10_000 });
    await waitForPricesLoaded(page);
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();

    await expect(
      page.getByRole('button', { name: /Community wants/ }),
    ).toHaveCount(0);
  });
});
