import { test, expect } from '@playwright/test';

test.describe('Search & query parsing', () => {
  test('plain name search returns matching cards', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();

    const input = page.getByRole('textbox', { name: 'Search cards...' }).first();
    await input.fill('luke skywalker');

    // Tile aria-labels include the variant in parens.
    await expect(page.getByRole('button', { name: /Luke Skywalker.*Standard/i }).first())
      .toBeVisible({ timeout: 5_000 });
  });

  test('set-code alias narrows results to that set', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();

    await page.getByRole('textbox', { name: 'Search cards...' }).first().fill('jtl luke');

    // Should hit Luke Skywalker - Hero of Yavin (JTL exclusive vs LAW
    // versions) — at least one matching tile must appear.
    await expect(page.getByRole('button', { name: /Luke Skywalker - Hero of Yavin/i }).first())
      .toBeVisible({ timeout: 5_000 });
  });

  test('common English words like "of" do not get aliased to a set', async ({ page }) => {
    // Regression for the slug-word alias bug: "Luke Skywalker - Hero
    // of Yavin" used to route via "of" → ashes-of-the-empire and
    // return zero matches.
    await page.goto('/');
    await page.getByRole('button', { name: 'Add cards to Offering' }).click();

    await page
      .getByRole('textbox', { name: 'Search cards...' })
      .first()
      .fill('Luke Skywalker - Hero of Yavin');

    await expect(page.getByRole('button', { name: /Luke Skywalker - Hero of Yavin.*Standard/i }))
      .toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('No cards match your filters')).not.toBeVisible();
  });
});
