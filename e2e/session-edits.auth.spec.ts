import { test, expect } from '@playwright/test';
import { filterConsoleErrors } from './_fixtures';
import {
  addOneCardToSide,
  closeAllParticipants,
  createAndClaimSession,
} from './helpers/sessions';

/**
 * Direct-edit coverage for the shared-session canvas: qty stepper,
 * remove-on-zero, empty/non-empty toggling, cross-side sync of edits.
 *
 * The qty-stepper tests are the regression guard for the
 * tradeCardKey parsing bug fixed in 5cbd5fc — `card.set` is a slug
 * like `jump-to-lightspeed`, so a naive `key.split('-').slice(0, -1)`
 * recovered the wrong productId, leading to net-zero edits on every
 * +/− click. Luke Skywalker - Hero of Yavin (Standard) is from JTL
 * (slug `jump-to-lightspeed`) and exercises the multi-segment-slug
 * code path; if the parsing regresses again, the qty-up assertions
 * below all fail because the button stays at "Remove" / qty=1.
 *
 * State-derived assertions (button aria-label flips) are preferred
 * over text matching ("does '2' appear?") — qty values collide with
 * many other numbers on the page (prices, line totals, etc.).
 *
 * Both participants are ghost users — same pattern as
 * session-lifecycle.auth.spec.ts.
 */

test.describe('Session edits — qty, remove, cross-side sync', () => {
  test.describe.configure({ mode: 'serial' });

  test('qty + advances the stepper on hyphenated-slug cards (regression for tradeCardKey parser)', async ({ browser }) => {
    const { a } = await createAndClaimSession(browser);

    try {
      // Add Luke (Standard) — JTL slug `jump-to-lightspeed` exercises
      // the multi-segment-slug parser path.
      await addOneCardToSide(a.page);

      // qty=1 → the decrement button has aria-label "Remove" (×).
      // No "Decrease quantity" button exists yet.
      await expect(
        a.page.getByRole('button', { name: 'Remove' }).first(),
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        a.page.getByRole('button', { name: 'Decrease quantity' }),
      ).toHaveCount(0);

      // Click + once: the button at the start of the stepper flips
      // from "Remove" to "Decrease quantity" (qty>1 path). If the
      // tradeCardKey parser is broken, the click is a net-zero edit
      // and the button label stays "Remove" — this assertion fails.
      await a.page.getByRole('button', { name: 'Increase quantity' }).first().click();
      await expect(
        a.page.getByRole('button', { name: 'Decrease quantity' }).first(),
      ).toBeVisible({ timeout: 5_000 });
      await expect(a.page.getByRole('button', { name: 'Remove' })).toHaveCount(0);

      // Click + again: still in qty>1 state. We don't assert the exact
      // value via text (qty digits collide with prices on the page) —
      // instead assert the row text-summary at the panel level.
      await a.page.getByRole('button', { name: 'Increase quantity' }).first().click();
      await expect(
        a.page.getByRole('button', { name: 'Decrease quantity' }).first(),
      ).toBeVisible();

      // Click − to step back down: still > 1 (now qty=2).
      await a.page.getByRole('button', { name: 'Decrease quantity' }).first().click();
      await expect(
        a.page.getByRole('button', { name: 'Decrease quantity' }).first(),
      ).toBeVisible();

      // Click − again: back to qty=1, button flips to "Remove".
      await a.page.getByRole('button', { name: 'Decrease quantity' }).first().click();
      await expect(
        a.page.getByRole('button', { name: 'Remove' }).first(),
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        a.page.getByRole('button', { name: 'Decrease quantity' }),
      ).toHaveCount(0);

      expect(filterConsoleErrors(a.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a]);
    }
  });

  test('× button removes the row when qty=1, returning the side to its empty tile', async ({ browser }) => {
    const { a } = await createAndClaimSession(browser);

    try {
      await addOneCardToSide(a.page);

      const removeBtn = a.page.getByRole('button', { name: 'Remove' }).first();
      await expect(removeBtn).toBeVisible({ timeout: 5_000 });
      await removeBtn.click();

      // Empty-tile affordance returns. Match the visible label "Add
      // cards to Your side" — the footer button is also gone since
      // the cards list is empty.
      await expect(
        a.page.getByRole('button', { name: /Add cards to Your side/i }).first(),
      ).toBeVisible({ timeout: 5_000 });
      await expect(a.page.getByText(/Luke Skywalker/i)).toHaveCount(0);

      expect(filterConsoleErrors(a.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a]);
    }
  });

  test('cross-side sync: counterpart sees adds + qty bumps + removes after the next poll', async ({ browser }) => {
    const { a, b } = await createAndClaimSession(browser);

    try {
      // A adds → B sees the row.
      await addOneCardToSide(a.page);
      await expect(b.page.getByText(/Luke Skywalker/i).first()).toBeVisible({ timeout: 8_000 });

      // A bumps qty to 2 → B's readOnly TradeRow renders "× 2".
      await a.page.getByRole('button', { name: 'Increase quantity' }).first().click();
      await expect(b.page.getByText(/× 2/i).first()).toBeVisible({ timeout: 8_000 });

      // A removes → B sees it disappear (× 2 marker also vanishes).
      // qty=2 means decrement-button aria-label is "Decrease quantity",
      // not "Remove" — step down once first.
      await a.page.getByRole('button', { name: 'Decrease quantity' }).first().click();
      await a.page.getByRole('button', { name: 'Remove' }).first().click();
      await expect(b.page.getByText(/Luke Skywalker/i)).toHaveCount(0, { timeout: 8_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });
});
