import { test, expect } from '@playwright/test';
import { signIn, createIsolatedUser, ensureTestUser, cleanupTestUser, type TestUser } from './helpers/auth';

/**
 * First-sign-in sync: server is the source of truth. Local items
 * only ever migrate UPWARD when the server is genuinely empty;
 * otherwise the server overwrites local. No dialog — the import-or-
 * start-fresh prompt got removed because dismissing it left devices
 * stuck unsynced.
 */
test.describe('First sign-in sync flow', () => {
  test.describe.configure({ mode: 'serial' });
  let user: TestUser;

  test.beforeEach(async () => {
    user = createIsolatedUser();
    await ensureTestUser(user);
  });

  test.afterEach(async () => {
    await cleanupTestUser(user);
  });

  test('local items + empty server → silently push local up to the server', async ({ context, page }) => {
    // Seed local items BEFORE signing in.
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.wants.v2', JSON.stringify([
        { id: 'local-w1', familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 2, restriction: { mode: 'any' }, addedAt: Date.now() },
      ]));
      window.localStorage.setItem('swu.available.v1', JSON.stringify([
        { id: 'local-a1', productId: '622133', qty: 1, addedAt: Date.now() },
      ]));
    });

    await signIn(context, user);
    await page.goto('/?view=trade');

    // No dialog — sign-in proceeds straight to the app.
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Import your lists?')).toBeHidden();

    // Local items got pushed to the server. Poll briefly so the
    // background sync has a chance to land before asserting.
    await expect.poll(async () => {
      const wants = await page.evaluate(async () => {
        const res = await fetch('/api/sync/wants');
        return res.json();
      });
      return Array.isArray(wants) ? wants.length : 0;
    }, { timeout: 10_000 }).toBe(1);

    const serverAvailable = await page.evaluate(async () => {
      const res = await fetch('/api/sync/available');
      return res.json();
    });
    expect(serverAvailable.length).toBe(1);
  });

  test('server has data + local has different data → server wins, local is overwritten', async ({ context, page }) => {
    // Pre-populate the server with one item via direct DB insert.
    const { getDb } = await import('../lib/db.js');
    const { wantsItems } = await import('../lib/schema.js');
    const { restrictionKey } = await import('../lib/shared.js');
    const db = getDb();
    await db.insert(wantsItems).values({
      id: `srv-${crypto.randomUUID().slice(0, 8)}`,
      userId: user.userId,
      familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin',
      qty: 1,
      restrictionMode: 'any',
      restrictionVariants: null,
      restrictionKey: restrictionKey({ mode: 'any' }),
      isPriority: false,
      addedAt: Date.now(),
    });

    // Seed local with a DIFFERENT item — server should win.
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.wants.v2', JSON.stringify([
        { id: 'local-w1', familyId: 'a-lawless-time::cad-bane-now-its-my-turn', qty: 9, restriction: { mode: 'any' }, addedAt: Date.now() },
      ]));
    });

    await signIn(context, user);
    await page.goto('/?view=trade');

    // No dialog — sign-in proceeds straight to the app.
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Import your lists?')).toBeHidden();

    // Server's view of wants is unchanged — the local Cad Bane row
    // didn't override the server's Luke row. Poll because the pull
    // step is async post-sign-in.
    await expect.poll(async () => {
      const wants = await page.evaluate(async () => {
        const res = await fetch('/api/sync/wants');
        return res.json();
      });
      return Array.isArray(wants) && wants.length === 1 ? wants[0].familyId : 'unknown';
    }, { timeout: 10_000 }).toBe('jump-to-lightspeed::luke-skywalker-hero-of-yavin');

    // Local cache also reflects the server view (the device's
    // localStorage got rewritten as part of pull-and-apply).
    const localWants = await page.evaluate(() => {
      const raw = window.localStorage.getItem('swu.wants.v2');
      return raw ? JSON.parse(raw) : null;
    });
    expect(localWants).toHaveLength(1);
    expect(localWants[0].familyId).toBe('jump-to-lightspeed::luke-skywalker-hero-of-yavin');
  });
});
