import { test, expect } from '@playwright/test';
import { signIn, createIsolatedUser, ensureTestUser, cleanupTestUser, type TestUser } from './helpers/auth';

test.describe('First sign-in migration flow', () => {
  test.describe.configure({ mode: 'serial' });
  let user: TestUser;

  test.beforeEach(async () => {
    user = createIsolatedUser();
    await ensureTestUser(user);
  });

  test.afterEach(async () => {
    await cleanupTestUser(user);
  });

  test('shows migration dialog when local items exist + server is empty → Import works', async ({ context, page }) => {
    // Seed local items BEFORE signing in.
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.wants.v2', JSON.stringify([
        { id: 'local-w1', familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 2, restriction: { mode: 'any' }, addedAt: Date.now() },
      ]));
      window.localStorage.setItem('swu.available.v1', JSON.stringify([
        { id: 'local-a1', productId: '622133', qty: 1, addedAt: Date.now() },
      ]));
    });

    // Now sign in — server is empty, local has items → migration prompt.
    await signIn(context, user);
    await page.goto('/');

    // Migration dialog should appear.
    await expect(page.getByText('Import your lists?')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/1 want/)).toBeVisible();
    await expect(page.getByText(/1 available/)).toBeVisible();

    // Click Import.
    await page.getByRole('button', { name: /Import 2 card/i }).click();

    // Dialog should dismiss. Verify items landed on the server.
    await expect(page.getByText('Import your lists?')).not.toBeVisible({ timeout: 5_000 });

    // Check server via API.
    const serverWants = await page.evaluate(async () => {
      const res = await fetch('/api/sync/wants');
      return res.json();
    });
    expect(serverWants.length).toBe(1);
  });

  test('Start fresh clears local and pulls from (empty) server', async ({ context, page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.wants.v2', JSON.stringify([
        { id: 'local-w1', familyId: 'x::y', qty: 1, restriction: { mode: 'any' }, addedAt: Date.now() },
      ]));
    });

    await signIn(context, user);
    await page.goto('/');

    await expect(page.getByText('Import your lists?')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /Start fresh/i }).click();

    // Dialog should dismiss — the choice was processed.
    await expect(page.getByText('Import your lists?')).not.toBeVisible({ timeout: 5_000 });

    // App should be usable (trade panels visible).
    await expect(page.getByRole('button', { name: 'Add cards to Offering' })).toBeVisible({ timeout: 10_000 });
  });

  test('no dialog when server already has data (returning user)', async ({ context, page }) => {
    // Pre-populate the server with data via direct DB insert.
    const { getDb } = await import('../lib/db.js');
    const { wantsItems } = await import('../lib/schema.js');
    const { restrictionKey } = await import('../lib/shared.js');
    const db = getDb();
    await db.insert(wantsItems).values({
      id: `srv-${crypto.randomUUID().slice(0, 8)}`,
      userId: user.userId,
      familyId: 'jtl::luke',
      qty: 1,
      restrictionMode: 'any',
      restrictionVariants: null,
      restrictionKey: restrictionKey({ mode: 'any' }),
      isPriority: false,
      addedAt: Date.now(),
    });

    // Seed local items too (to trigger migration check).
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.wants.v2', JSON.stringify([
        { id: 'local-w1', familyId: 'law::cad-bane', qty: 1, restriction: { mode: 'any' }, addedAt: Date.now() },
      ]));
    });

    await signIn(context, user);
    await page.goto('/');

    // Wait for auth to load — account menu button is the stable
    // signed-in signal now (username lives inside the popover).
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 15_000 });
    // Explicitly verify dialog does NOT appear.
    await page.waitForTimeout(2000);
    await expect(page.getByText('Import your lists?')).not.toBeVisible();
  });
});
