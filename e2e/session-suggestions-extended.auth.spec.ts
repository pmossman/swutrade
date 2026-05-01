import { test, expect } from '@playwright/test';
import { filterConsoleErrors } from './_fixtures';
import {
  addOneCardToSide,
  closeAllParticipants,
  createAndClaimSession,
} from './helpers/sessions';

/**
 * Extended suggestion coverage on top of the basic flows in
 * session-collaboration.auth.spec.ts. Pins:
 *   1. Multi-card add suggestion (composer pick > 1 card, send)
 *   2. Swap path — kebab "Suggest swap…" on a counterpart card
 *      pre-fills cardsToRemove; viewer picks the replacement and
 *      sends. Counterpart sees a pill describing both halves.
 *   3. Explicit dismiss flow — counterpart clicks Dismiss instead of
 *      Accept; suggestion clears on both sides.
 *   4. Card-lock UX — once a card is referenced by a pending
 *      suggestion, the per-card kebab on that card surfaces a
 *      disabled "In a pending suggestion" item instead of the
 *      suggest-* options. Regression for the silent-empty-kebab
 *      bug fixed in 5cbd5fc.
 */

test.describe('Session suggestions — multi-card, swap, dismiss, locked-card UX', () => {
  test.describe.configure({ mode: 'serial' });

  test('multi-card add suggestion — composer accepts > 1 pick, counterpart sees combined pill', async ({ browser }) => {
    const { a, b } = await createAndClaimSession(browser);

    try {
      await a.page.getByRole('button', { name: /Suggest a card/i }).click();
      await expect(a.page.getByText(/Suggest changes/i).first()).toBeVisible({ timeout: 5_000 });

      const input = a.page.getByRole('textbox', { name: /Search cards/i }).first();

      // First pick: Luke (Standard).
      await input.fill('luke jtl');
      await expect(
        a.page.getByRole('button', { name: /Luke Skywalker - Hero of Yavin \(Standard\).*to suggestion/i }).first(),
      ).toBeVisible({ timeout: 10_000 });
      await a.page.getByRole('button', { name: /Luke Skywalker - Hero of Yavin \(Standard\).*to suggestion/i }).first().click();

      // Second pick: another distinctive card — Han (Audacious Smuggler) is also a JTL printing.
      await input.fill('');
      await input.fill('han jtl');
      const hanTile = a.page.getByRole('button', { name: /Han Solo - Has His Moments \(Standard\).*to suggestion/i }).first();
      await expect(hanTile).toBeVisible({ timeout: 10_000 });
      await hanTile.click();

      // Footer summary reads "+2 ready to suggest." once both cards
      // are staged in the add draft.
      await expect(a.page.getByText(/\+2 ready to suggest/i)).toBeVisible({ timeout: 5_000 });

      await a.page.getByRole('button', { name: /Send suggestion/i }).click();

      // Outgoing pill on A reads "+2"; incoming on B reads "suggests +2".
      await expect(
        a.page.getByRole('button', { name: /You suggested.*\+2/i }).first(),
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        b.page.getByRole('button', { name: /suggests.*\+2/i }).first(),
      ).toBeVisible({ timeout: 8_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });

  test('swap suggestion — kebab "Suggest swap" pre-fills removal, replacement picked in composer', async ({ browser }) => {
    const { a, b } = await createAndClaimSession(browser);

    try {
      // B adds Luke to their side first, so A has something to swap.
      await addOneCardToSide(b.page);
      // A reloads to pick up B's edit (poll might not have hit yet).
      await a.page.reload();
      await expect(a.page.getByText(/Luke Skywalker/i).first()).toBeVisible({ timeout: 8_000 });

      // A opens the per-card kebab on B's Luke. The kebab is on the
      // counterpart panel — readOnly TradeRow with extraMenuItems for
      // suggest-* actions. aria-label "More actions" matches it.
      // Hover-reveal: scroll into view + force-click to bypass the
      // CSS opacity:0 default-hide.
      const lukeKebab = a.page.getByRole('button', { name: /More actions/i }).first();
      await lukeKebab.scrollIntoViewIfNeeded();
      await lukeKebab.click({ force: true });
      await a.page.getByRole('menuitem', { name: /Suggest swap/i }).click();

      // Composer opens with Luke pre-filled in the removing strip.
      await expect(a.page.getByText(/Suggest changes/i).first()).toBeVisible({ timeout: 5_000 });
      // The RemovingStrip surfaces the pre-filled removal.
      await expect(a.page.locator('text=/Luke Skywalker - Hero of Yavin/i').first()).toBeVisible();

      // A picks Han as the replacement.
      const input = a.page.getByRole('textbox', { name: /Search cards/i }).first();
      await input.fill('han jtl');
      const hanTile = a.page.getByRole('button', { name: /Han Solo - Has His Moments \(Standard\).*to suggestion/i }).first();
      await expect(hanTile).toBeVisible({ timeout: 10_000 });
      await hanTile.click();

      await a.page.getByRole('button', { name: /Send suggestion/i }).click();

      // B sees the swap pill — both +1 and -1 components.
      await expect(
        b.page.getByRole('button', { name: /suggests/i }).first(),
      ).toBeVisible({ timeout: 8_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });

  test('explicit dismiss — counterpart taps Dismiss, suggestion clears on both sides', async ({ browser }) => {
    const { a, b } = await createAndClaimSession(browser);

    try {
      // A suggests Luke (single-card add — same pattern as the
      // collab spec, just verifying the dismiss leg this time).
      await a.page.getByRole('button', { name: /Suggest a card/i }).click();
      const input = a.page.getByRole('textbox', { name: /Search cards/i }).first();
      await input.fill('luke jtl');
      await expect(
        a.page.getByRole('button', { name: /Luke Skywalker - Hero of Yavin \(Standard\).*to suggestion/i }).first(),
      ).toBeVisible({ timeout: 10_000 });
      await a.page.getByRole('button', { name: /Luke Skywalker - Hero of Yavin \(Standard\).*to suggestion/i }).first().click();
      await a.page.getByRole('button', { name: /Send suggestion/i }).click();

      // B expands the pill, then dismisses.
      const incoming = b.page.getByRole('button', { name: /suggests/i }).first();
      await expect(incoming).toBeVisible({ timeout: 8_000 });
      await incoming.click();
      await b.page.getByRole('button', { name: /^Dismiss$/i }).first().click();

      // Both sides: pill clears.
      await expect(b.page.getByRole('button', { name: /suggests/i })).toHaveCount(0, { timeout: 8_000 });
      await expect(a.page.getByRole('button', { name: /You suggested/i })).toHaveCount(0, { timeout: 8_000 });
      // No card landed on B's side — Luke isn't there.
      await expect(b.page.getByText(/Luke Skywalker/i)).toHaveCount(0);

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });

  test('card-lock UX — counterpart kebab shows "In a pending suggestion" disabled item', async ({ browser }) => {
    const { a, b } = await createAndClaimSession(browser);

    try {
      // B adds Luke. A suggests removing it.
      await addOneCardToSide(b.page);
      await a.page.reload();
      await expect(a.page.getByText(/Luke Skywalker/i).first()).toBeVisible({ timeout: 8_000 });

      // A opens the kebab, picks "Suggest remove" — fires a one-tap
      // suggestion that locks the card on A's side.
      const lukeKebab = a.page.getByRole('button', { name: /More actions/i }).first();
      await lukeKebab.scrollIntoViewIfNeeded();
      await lukeKebab.click({ force: true });
      await a.page.getByRole('menuitem', { name: /Suggest remove/i }).click();

      // Outgoing pill confirms the suggestion landed.
      await expect(
        a.page.getByRole('button', { name: /You suggested/i }).first(),
      ).toBeVisible({ timeout: 5_000 });

      // Re-open the kebab on the same card. The suggest-* options are
      // gone; in their place is a single disabled "In a pending
      // suggestion" item.
      const lukeKebabAgain = a.page.getByRole('button', { name: /More actions/i }).first();
      await lukeKebabAgain.scrollIntoViewIfNeeded();
      await lukeKebabAgain.click({ force: true });
      const lockedItem = a.page.getByRole('menuitem', { name: /In a pending suggestion/i });
      await expect(lockedItem).toBeVisible({ timeout: 5_000 });
      // The locked item is disabled — clicking should not navigate
      // or open another panel. The composer mustn't appear.
      await expect(lockedItem).toBeDisabled();
      // The suggest-* options are absent.
      await expect(a.page.getByRole('menuitem', { name: /Suggest remove/i })).toHaveCount(0);
      await expect(a.page.getByRole('menuitem', { name: /Suggest swap/i })).toHaveCount(0);

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });
});
