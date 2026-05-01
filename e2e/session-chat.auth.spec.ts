import { test, expect } from '@playwright/test';
import { filterConsoleErrors } from './_fixtures';
import {
  addOneCardToSide,
  clickAndWaitForEdit,
  closeAllParticipants,
  createAndClaimSession,
} from './helpers/sessions';

/**
 * Chat-specific coverage on top of session-collaboration.auth.spec.ts
 * (which already pins the basic chat round-trip).
 *
 * Pins:
 *   1. Send button is disabled when the draft is empty or
 *      whitespace-only — `draft.trim().length === 0` gate.
 *   2. Chat-only unread badge — when B sends a chat, A's
 *      "Chat & history" badge lights up. When A edits their own
 *      side (qty bump), the badge does NOT count that edit. This
 *      is the regression for the chat-specific countUnreadEvents
 *      filter (eb08f28).
 *   3. Rate limit — 10 messages in a minute is allowed; the 11th
 *      surfaces the "Slow down a moment" error in the chat panel.
 */

test.describe('Session chat — disabled-when-empty, badge filter, rate limit', () => {
  test.describe.configure({ mode: 'serial' });

  test('Send button stays disabled while the draft is empty or whitespace', async ({ browser }) => {
    const { a } = await createAndClaimSession(browser);

    try {
      await a.page.getByRole('button', { name: /Chat & history/i }).first().click();

      const draft = a.page.getByPlaceholder(/Send a message/i);
      const sendBtn = a.page.getByRole('button', { name: /^Send$/ });

      // Empty draft → Send disabled.
      await expect(draft).toBeVisible({ timeout: 5_000 });
      await expect(sendBtn).toBeDisabled();

      // Whitespace-only → still disabled (`trim().length === 0`).
      await draft.fill('   ');
      await expect(sendBtn).toBeDisabled();

      // Non-whitespace content → enabled.
      await draft.fill('hello');
      await expect(sendBtn).toBeEnabled();

      // Trim a real message back down — re-disables.
      await draft.fill('');
      await expect(sendBtn).toBeDisabled();

      expect(filterConsoleErrors(a.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a]);
    }
  });

  test('chat-only unread badge — chat lights it up, qty edit does not', async ({ browser }) => {
    const { a, b } = await createAndClaimSession(browser);

    try {
      // Both add a card so qty stepper is reachable on A's side.
      await addOneCardToSide(a.page);
      await addOneCardToSide(b.page);

      // A bumps qty → the local badge must NOT light up. The
      // chat button stays in its no-unread visual state. Without
      // explicit state-derived assertion we'd be color-comparing,
      // so instead we sanity-check by clicking + and verifying
      // no unread count appears in the button label. The
      // aria-label format is "Chat & history" with no count when
      // unread===0; it becomes "Chat & history (N unread)" otherwise.
      await clickAndWaitForEdit(a.page, 'Increase quantity');
      // Wait a poll so any side effects can surface.
      await a.page.waitForTimeout(3_000);

      const chatBtnNoUnread = a.page.getByRole('button', { name: /^Chat & history$/i });
      await expect(chatBtnNoUnread).toBeVisible({ timeout: 5_000 });
      // No "(N unread)" suffix yet.
      await expect(a.page.getByRole('button', { name: /\(\d+ unread\)/i })).toHaveCount(0);

      // Now B sends a chat message. A's badge should flip to "1 unread".
      await b.page.getByRole('button', { name: /Chat & history/i }).first().click();
      const bDraft = b.page.getByPlaceholder(/Send a message/i);
      await expect(bDraft).toBeVisible({ timeout: 5_000 });
      await bDraft.fill('hello from B');
      await b.page.getByRole('button', { name: /^Send$/ }).click();

      // A's chat button reflects 1 unread after the next poll.
      await expect(
        a.page.getByRole('button', { name: /Chat & history \(1 unread\)/i }),
      ).toBeVisible({ timeout: 8_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });

  test('rate limit — 11th chat in under a minute surfaces "Slow down a moment"', async ({ browser }) => {
    const { a } = await createAndClaimSession(browser);

    try {
      await a.page.getByRole('button', { name: /Chat & history/i }).first().click();
      const draft = a.page.getByPlaceholder(/Send a message/i);
      await expect(draft).toBeVisible({ timeout: 5_000 });
      const sendBtn = a.page.getByRole('button', { name: /^Send$/ });

      // Send 10 messages — server allows up to 10/min.
      for (let i = 1; i <= 10; i++) {
        await draft.fill(`msg ${i}`);
        await sendBtn.click();
        // Wait for the input to clear (success path) or for an error
        // to surface. Successful sends clear the draft to '' so we
        // can immediately fill the next one.
        await expect(draft).toHaveValue('', { timeout: 5_000 });
      }

      // 11th submission triggers the rate limiter.
      await draft.fill('msg 11');
      await sendBtn.click();
      // Error surface: SessionTimelinePanel renders the rate-limited
      // string above the input.
      await expect(
        a.page.getByText(/Slow down a moment/i),
      ).toBeVisible({ timeout: 8_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a]);
    }
  });
});
