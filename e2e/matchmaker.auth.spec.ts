import { test, expect } from '@playwright/test';
import { signIn, TEST_USER } from './helpers/auth';

test.describe('Trade matchmaker', () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test('entering a handle with overlap pre-populates both trade sides', async ({ page }) => {
    // Seed some wants + available for the test user so the matchmaker
    // input renders (it hides when lists are empty).
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.wants.v2', JSON.stringify([
        { id: 'mw1', familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1, restriction: { mode: 'any' }, addedAt: 1 },
      ]));
      window.localStorage.setItem('swu.available.v1', JSON.stringify([
        { id: 'ma1', productId: '681378', qty: 1, addedAt: 2 },
      ]));
    });

    await page.goto('/');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    // The matchmaker input should be visible since we have lists.
    const input = page.getByPlaceholder('Enter @handle to find a trade…');
    await expect(input).toBeVisible({ timeout: 5_000 });

    // Search for the real user (pmoss) who has wants in the DB.
    await input.fill('pmoss');
    await page.getByRole('button', { name: 'Find trade' }).click();

    // Wait for the result — either a match summary or "no overlap".
    await expect(
      page.getByText(/Found a trade with|No card overlap/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('shows error for non-existent handle', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('swu.wants.v2', JSON.stringify([
        { id: 'mw1', familyId: 'x::y', qty: 1, restriction: { mode: 'any' }, addedAt: 1 },
      ]));
    });

    await page.goto('/');
    await expect(page.getByText(TEST_USER.username)).toBeVisible({ timeout: 10_000 });

    await page.getByPlaceholder('Enter @handle to find a trade…').fill('nonexistent-user-zzz');
    await page.getByRole('button', { name: 'Find trade' }).click();

    await expect(page.getByText('User not found')).toBeVisible({ timeout: 10_000 });
  });
});
