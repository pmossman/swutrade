import { test, expect } from '@playwright/test';
import { filterConsoleErrors } from './_fixtures';
import {
  addOneCardToSide,
  closeAllParticipants,
  createAndClaimSession,
} from './helpers/sessions';

/**
 * Extended revert coverage on top of session-collaboration.auth.spec.ts
 * (which already pins the propose → counterpart accept happy path).
 *
 * Pins added here:
 *   1. Latest-state kebab is hidden — when only one edit exists,
 *      reverting "to this state" would be a no-op, so the kebab
 *      doesn't render (per the fix in 365bf62).
 *   2. Older-edit kebab is present once a newer edit exists. Click
 *      reveals "Revert to this state" and proposes the revert.
 *   3. Counterpart explicit dismiss — instead of accepting, B taps
 *      Dismiss; the revert pill clears on both sides without
 *      flipping any cards.
 */

test.describe('Session revert — kebab visibility, dismiss path', () => {
  test.describe.configure({ mode: 'serial' });

  test('latest-state kebab is suppressed when only one edited event exists', async ({ browser }) => {
    const { a } = await createAndClaimSession(browser);

    try {
      // A edits exactly once.
      await addOneCardToSide(a.page);
      // Wait for the post-edit poll so the timeline carries the
      // 'edited' event.
      await a.page.waitForTimeout(3_000);

      // Open the timeline. The single 'edited' event represents the
      // current state — its kebab is suppressed.
      await a.page.getByRole('button', { name: /Chat & history/i }).first().click();

      // No "Revert options" kebabs visible. (Other revert-related
      // affordances live on per-event rows; this assertion is the
      // direct expression of the fix in 365bf62.)
      await expect(a.page.getByRole('button', { name: /^Revert options$/i })).toHaveCount(0, { timeout: 5_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a]);
    }
  });

  test('older-edit kebab appears once a newer edit lands; opening reveals Revert option', async ({ browser }) => {
    const { a, b } = await createAndClaimSession(browser);

    try {
      // First edit: A adds a card.
      await addOneCardToSide(a.page);
      // Second edit on the OTHER side so debounce doesn't merge
      // them. (recordOrMergeEditedPair only collapses consecutive
      // same-actor edits inside the merge window.)
      await addOneCardToSide(b.page);
      // Wait for both edits to surface in A's timeline.
      await a.page.waitForTimeout(3_000);

      // Open the timeline.
      await a.page.getByRole('button', { name: /Chat & history/i }).first().click();

      // Two edited events, latest is suppressed → exactly 1 kebab.
      const revertKebabs = a.page.getByRole('button', { name: /^Revert options$/i });
      await expect(revertKebabs).toHaveCount(1, { timeout: 8_000 });

      // Click reveals "Revert to this state" menu item.
      await revertKebabs.first().click();
      await expect(
        a.page.getByRole('button', { name: /Revert to this state/i }),
      ).toBeVisible({ timeout: 5_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });

  test('counterpart dismisses a revert proposal — pill clears on both sides without flipping cards', async ({ browser }) => {
    const { a, b } = await createAndClaimSession(browser);

    try {
      // Two distinct snapshots: A edits, then B edits.
      await addOneCardToSide(a.page);
      await addOneCardToSide(b.page);
      await a.page.waitForTimeout(3_000);

      // A proposes a revert to A's edit (the older snapshot — at that
      // point A had a card and B didn't yet).
      await a.page.getByRole('button', { name: /Chat & history/i }).first().click();
      const revertKebabs = a.page.getByRole('button', { name: /^Revert options$/i });
      await expect(revertKebabs.first()).toBeVisible({ timeout: 8_000 });
      await revertKebabs.first().click();
      await a.page.getByRole('button', { name: /Revert to this state/i }).click();

      // A sees the pill confirming the proposal.
      await expect(a.page.getByText(/proposed reverting both sides/i)).toBeVisible({ timeout: 5_000 });

      // B sees the same pill, taps to expand, then Dismiss.
      const bPill = b.page.getByRole('button', { name: /proposed reverting both sides/i });
      await expect(bPill).toBeVisible({ timeout: 8_000 });
      await bPill.click();
      await b.page.getByRole('button', { name: /^Dismiss$/i }).first().click();

      // Pill clears on both sides.
      await expect(b.page.getByText(/proposed reverting both sides/i)).toHaveCount(0, { timeout: 8_000 });
      await expect(a.page.getByText(/proposed reverting both sides/i)).toHaveCount(0, { timeout: 8_000 });

      // The cards stayed put — A still has Luke (not reverted), B
      // still has Luke. Re-asserting via the panels confirms the
      // dismiss didn't apply the snapshot.
      await expect(a.page.getByText(/Luke Skywalker/i).first()).toBeVisible();
      await expect(b.page.getByText(/Luke Skywalker/i).first()).toBeVisible();

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });
});
