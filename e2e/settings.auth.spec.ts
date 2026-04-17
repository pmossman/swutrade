import { test, expect } from '@playwright/test';
import { signIn, createIsolatedUser, ensureTestUser, cleanupTestUser, type TestUser } from './helpers/auth';
import {
  installBotInGuild,
  createGuildMembership,
  getGuildMembership,
  getUserSettings,
} from './helpers/guilds';

test.describe('Settings view', () => {
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

  test('loads account settings with defaults', async ({ page }) => {
    await page.goto('/?settings=1');
    await expect(page.getByText(/^Settings$/i).first()).toBeVisible({ timeout: 10_000 });

    await expect(page.getByLabel('Profile visibility')).toHaveValue('discord');
    // "Trade proposals sent to me" starts checked; the others don't.
    await expect(page.getByRole('checkbox', { name: /Trade proposals sent to me/ }))
      .toBeChecked();
    await expect(page.getByRole('checkbox', { name: /^Match alerts/ }))
      .not.toBeChecked();
  });

  test('toggling a bot-DM category persists', async ({ page }) => {
    await page.goto('/?settings=1');

    const matchAlerts = page.getByRole('checkbox', { name: /^Match alerts/ });
    await expect(matchAlerts).not.toBeChecked();
    await matchAlerts.check();

    // Wait for save to round-trip by asserting the underlying DB
    // state reflects the change (more reliable than sleeping).
    await expect.poll(async () => {
      const s = await getUserSettings(user.userId);
      return s?.dmMatchAlerts;
    }, { timeout: 5_000 }).toBe(true);
  });

  test('changing profile visibility persists', async ({ page }) => {
    await page.goto('/?settings=1');

    await page.getByLabel('Profile visibility').selectOption('discord');

    await expect.poll(async () => {
      const s = await getUserSettings(user.userId);
      return s?.profileVisibility;
    }, { timeout: 5_000 }).toBe('discord');
  });

  test('shows an empty-state when no bot-installed guilds are available', async ({ page }) => {
    // Seed a membership in a guild where the bot is NOT installed — it
    // should land in "other servers", not the enrollable section.
    cleanups.push(await createGuildMembership(user.userId, `lurker-${user.userId}`, {
      guildName: 'Elsewhere',
    }));

    await page.goto('/?settings=1');
    await expect(page.getByText(/SWUTrade's bot isn't installed in any of your Discord servers yet/i))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Elsewhere')).toBeVisible();
  });

  test('enrolling flips the bundle + shows the sub-toggles', async ({ page }) => {
    const guildId = `enroll-${user.userId}`;
    cleanups.push(await installBotInGuild(guildId, { guildName: 'Star Wars SD' }));
    cleanups.push(await createGuildMembership(user.userId, guildId, {
      guildName: 'Star Wars SD',
    }));

    await page.goto('/?settings=1');

    await expect(page.getByText('Star Wars SD')).toBeVisible({ timeout: 10_000 });
    const enrollCheckbox = page.getByRole('checkbox', { name: 'Enroll in Star Wars SD' });
    await expect(enrollCheckbox).not.toBeChecked();

    await enrollCheckbox.check();

    // Sub-toggles appear after enrollment, already checked by the bundle default.
    await expect(page.getByRole('checkbox', { name: /Include in community rollups/ }))
      .toBeChecked({ timeout: 5_000 });
    await expect(page.getByRole('checkbox', { name: /Appear in who-has queries/ }))
      .toBeChecked();

    // DB confirms the bundle.
    await expect.poll(async () => {
      const row = await getGuildMembership(user.userId, guildId);
      return row && { enrolled: row.enrolled, inc: row.includeInRollups, appear: row.appearInQueries };
    }, { timeout: 5_000 }).toEqual({ enrolled: true, inc: true, appear: true });
  });

  test('disenrolling clears the bundle', async ({ page }) => {
    const guildId = `disenroll-${user.userId}`;
    cleanups.push(await installBotInGuild(guildId, { guildName: 'Star Wars SD' }));
    cleanups.push(await createGuildMembership(user.userId, guildId, {
      guildName: 'Star Wars SD',
      enrolled: true,
    }));

    await page.goto('/?settings=1');
    const enrollCheckbox = page.getByRole('checkbox', { name: 'Enroll in Star Wars SD' });
    await expect(enrollCheckbox).toBeChecked({ timeout: 10_000 });

    await enrollCheckbox.uncheck();

    await expect.poll(async () => {
      const row = await getGuildMembership(user.userId, guildId);
      return row && { enrolled: row.enrolled, inc: row.includeInRollups, appear: row.appearInQueries };
    }, { timeout: 5_000 }).toEqual({ enrolled: false, inc: false, appear: false });
  });
});
