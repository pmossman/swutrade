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

  test('hub shows sections; profile tab carries profile visibility at default', async ({ page }) => {
    // Post-rework the bare `/?settings=1` URL is a hub. Drill-down via
    // `tab=profile` surfaces the actual Profile visibility field.
    await page.goto('/?settings=1');
    await expect(page.getByText(/^Settings$/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Profile/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Preferences/i })).toBeVisible();

    await page.goto('/?settings=1&tab=profile');
    await expect(page.getByLabel('Profile visibility')).toHaveValue('discord');
  });

  test('toggling a bot-DM category persists (preferences tab)', async ({ page }) => {
    await page.goto('/?settings=1&tab=preferences');

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

  test('changing Thread conversations (communicationPref) persists (preferences tab)', async ({ page }) => {
    await page.goto('/?settings=1&tab=preferences');

    const commPref = page.getByLabel('Thread conversations');
    await expect(commPref).toHaveValue('allow');
    await commPref.selectOption('prefer');

    await expect.poll(async () => {
      const s = await getUserSettings(user.userId);
      return s?.communicationPref;
    }, { timeout: 5_000 }).toBe('prefer');
  });

  test('changing profile visibility persists (profile tab)', async ({ page }) => {
    await page.goto('/?settings=1&tab=profile');

    await page.getByLabel('Profile visibility').selectOption('public');

    await expect.poll(async () => {
      const s = await getUserSettings(user.userId);
      return s?.profileVisibility;
    }, { timeout: 5_000 }).toBe('public');
  });

  test('servers tab shows an empty-state when no bot-installed guilds are available', async ({ page }) => {
    // Seed a membership in a guild where the bot is NOT installed.
    // As of Phase 4b we deliberately DON'T enumerate these — a user
    // with 60 random Discord servers doesn't want them listed in
    // settings. The guild name should stay off-screen; an "Invite
    // SWUTrade bot" block shows in its place.
    cleanups.push(await createGuildMembership(user.userId, `lurker-${user.userId}`, {
      guildName: 'Elsewhere',
    }));

    await page.goto('/?settings=1&tab=servers');
    await expect(page.getByText(/SWUTrade's bot isn't installed in any of your Discord servers yet/i))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Want SWUTrade in another server\?/i)).toBeVisible();
    // The bot-less guild name must NOT appear on the page.
    await expect(page.getByText('Elsewhere')).toHaveCount(0);
  });

  test('enrolling a server from the server detail flips the bundle on', async ({ page }) => {
    const guildId = `enroll-${user.userId}`;
    cleanups.push(await installBotInGuild(guildId, { guildName: 'Star Wars SD' }));
    cleanups.push(await createGuildMembership(user.userId, guildId, {
      guildName: 'Star Wars SD',
    }));

    // Drill directly to the server's detail page — skips the hub row click.
    await page.goto(`/?settings=1&tab=servers&guild=${guildId}`);

    await expect(page.getByText('Star Wars SD').first()).toBeVisible({ timeout: 10_000 });
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

  test('disenrolling from the server detail clears the bundle', async ({ page }) => {
    const guildId = `disenroll-${user.userId}`;
    cleanups.push(await installBotInGuild(guildId, { guildName: 'Star Wars SD' }));
    cleanups.push(await createGuildMembership(user.userId, guildId, {
      guildName: 'Star Wars SD',
      enrolled: true,
    }));

    await page.goto(`/?settings=1&tab=servers&guild=${guildId}`);
    const enrollCheckbox = page.getByRole('checkbox', { name: 'Enroll in Star Wars SD' });
    await expect(enrollCheckbox).toBeChecked({ timeout: 10_000 });

    await enrollCheckbox.uncheck();

    await expect.poll(async () => {
      const row = await getGuildMembership(user.userId, guildId);
      return row && { enrolled: row.enrolled, inc: row.includeInRollups, appear: row.appearInQueries };
    }, { timeout: 5_000 }).toEqual({ enrolled: false, inc: false, appear: false });
  });
});
