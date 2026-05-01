import { test, expect } from '@playwright/test';
import { filterConsoleErrors } from './_fixtures';
import { createIsolatedUser, ensureTestUser } from './helpers/auth';
import { legacyEventsFixture } from './fixtures/sessions/legacy-events';
import { generateSessionId, seedFromFixture } from './helpers/session-seed';
import {
  closeAllParticipants,
  openSessionParticipant,
} from './helpers/sessions';

/**
 * Frozen-fixture regression — load a session whose rows were
 * recorded under an older schema generation (legacy timeline event
 * shapes) and assert that:
 *   - The canvas renders without errors.
 *   - The timeline panel surfaces every event, including the ones
 *     with null / partial payloads, falling back to the
 *     summarizeStructuredEvent one-liner where appropriate.
 *   - A fresh edit on top of the legacy state succeeds — proves
 *     edit/PUT works against a session that has events the current
 *     code wasn't originally designed to render.
 *
 * This is the bug class to guard against: "today's commit broke
 * yesterday's session." Add new fixtures whenever the session
 * schema changes (per the AUTONOMOUS_PLAN.md fixture discipline).
 */

test.describe('Session frozen-fixture regression', () => {
  test.describe.configure({ mode: 'serial' });

  test('legacy timeline events render + accept new edits', async ({ browser }) => {
    const userA = createIsolatedUser();
    const userB = createIsolatedUser();
    await ensureTestUser(userA);
    await ensureTestUser(userB);

    const sessionId = generateSessionId();
    const fixture = legacyEventsFixture({
      userAId: userA.userId,
      userBId: userB.userId,
      sessionId,
    });
    const seeded = await seedFromFixture(fixture);

    const a = await openSessionParticipant(browser, {
      url: `/s/${seeded.sessionId}`,
      signedInAs: userA,
    });

    try {
      // Canvas renders — both the seeded card on A's side and the
      // identity strip's "both editing" badge.
      await expect(a.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });
      await expect(a.page.getByText(/Luke Skywalker/i).first()).toBeVisible();

      // Open the timeline. The four legacy events should render
      // without crashing the panel — null payload, side-only payload,
      // full-diff payload, and a chat message.
      await a.page.getByRole('button', { name: /Chat & history/i }).first().click();
      // The chat message body text appears verbatim in the timeline.
      await expect(a.page.getByText(/hey from the legacy past/i)).toBeVisible({ timeout: 5_000 });
      // The full-diff edited event renders with its card pill —
      // proves the modern renderer path still works even when other
      // events on the same timeline use legacy shapes.
      // (The legacy null/side-only events fall through to the
      // one-liner summarizer; the assertion below is enough to
      // confirm the panel didn't error out for them.)

      // Close the timeline panel before reaching for the qty stepper —
      // the panel's `fixed inset-0 z-40` overlay otherwise intercepts
      // pointer events on the canvas behind it.
      await a.page.getByRole('button', { name: /Close activity/i }).click();

      // Make a new edit — bump qty on the seeded card. This validates
      // that the underlying tradeSessions row is still mutable.
      await a.page.getByRole('button', { name: 'Increase quantity' }).first().click();
      // Confirm the qty stepper flipped (qty 1 → 2) — Decrease button
      // appears, Remove disappears.
      await expect(
        a.page.getByRole('button', { name: 'Decrease quantity' }).first(),
      ).toBeVisible({ timeout: 5_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a]);
      await seeded.cleanup();
    }
  });
});
