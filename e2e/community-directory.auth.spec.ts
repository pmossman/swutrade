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
 * Covers the directory view at /?community=1 — one row per user in
 * a mutually-enrolled + queryable guild.
 *
 * Scope: confirm the consent gates propagate end-to-end. A member
 * with `appearInQueries=true` should render; one with it off must
 * not. Overlap count math is covered server-side
 * (me-community-members.test.ts) and in the component's memo logic;
 * a dedicated e2e math assertion would add no coverage signal over
 * what's already green.
 */
test.describe('Community directory view', () => {
  test.describe.configure({ mode: 'serial' });
  let user: TestUser;
  const cleanups: Array<() => Promise<void>> = [];

  test.beforeEach(async ({ context }) => {
    user = createIsolatedUser();
    await ensureTestUser(user);
    await signIn(context, user);
  });

  test.afterEach(async () => {
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
    await cleanupTestUser(user);
  });

  test('lists queryable mutual-guild members + hides non-queryable ones', async ({ page }) => {
    const guildId = `e2e-dir-${user.userId}`;
    cleanups.push(await installBotInGuild(guildId, { guildName: 'E2E Trade Hall' }));
    cleanups.push(await createGuildMembership(user.userId, guildId, {
      enrolled: true,
      appearInQueries: true,
      guildName: 'E2E Trade Hall',
    }));

    const visible = await createSenderFixture({
      handle: `dir-visible-${Date.now().toString(36)}`,
    });
    cleanups.push(visible.cleanup);
    cleanups.push(await createGuildMembership(visible.userId, guildId, {
      enrolled: true,
      appearInQueries: true,
      guildName: 'E2E Trade Hall',
    }));

    const hidden = await createSenderFixture({
      handle: `dir-hidden-${Date.now().toString(36)}`,
    });
    cleanups.push(hidden.cleanup);
    cleanups.push(await createGuildMembership(hidden.userId, guildId, {
      enrolled: true,
      appearInQueries: false,
      guildName: 'E2E Trade Hall',
    }));

    await page.goto('/?community=1');
    // Community 2.0 auto-redirects single-guild users into that
    // guild's page — wait for the Members tab to appear as the
    // structural "we made it into the guild space" signal. The
    // breadcrumb "Community" link was flaky on CI (timing-dependent
    // on the redirect + render) so anchor to a stable guild-view
    // element instead.
    await expect(page.getByRole('tab', { name: /members/i }).first())
      .toBeVisible({ timeout: 10_000 });
    // Click into the Members tab to ensure we're looking at the
    // directory content the rest of the assertions check against.
    await page.getByRole('tab', { name: /members/i }).click();

    await expect(page.getByText(`@${visible.handle}`)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(`@${hidden.handle}`)).toHaveCount(0);
    await expect(page.getByText('E2E Trade Hall').first()).toBeVisible();
  });

  test('empty state renders when viewer has no queryable enrollment', async ({ page }) => {
    await page.goto('/?community=1');
    // Community 2.0 surfaces a guild-selector-first empty state when
    // the viewer has no enrolled servers at all — the old "no
    // overlapping members" copy now only shows inside a guild space.
    await expect(page.getByText(/haven't enrolled in any Discord servers/i))
      .toBeVisible({ timeout: 10_000 });
  });
});
