import { test, expect } from '@playwright/test';
import { filterConsoleErrors } from './_fixtures';
import {
  closeAllParticipants,
  createAndClaimSession,
} from './helpers/sessions';

/**
 * Mobile-specific UX coverage for the session canvas.
 *
 * Pins:
 *   1. Below the 768px mobile breakpoint, the segmented "Yours / Both
 *      / @counterpart" SplitViewToggle is rendered (it's hidden on
 *      desktop where the side-by-side grid is sufficient). Tapping
 *      each chip collapses the OTHER panel. Tapping "Both" restores.
 *   2. Form inputs render at >= 16px font-size on mobile so iOS
 *      Safari doesn't auto-zoom on focus. Direct expression of the
 *      `@media (max-width: 767px)` rule in src/index.css.
 *
 * The visualViewport panel-sizing path is harder to exercise in
 * headless chromium (no soft keyboard) so it's left to manual QA;
 * the rest is fully testable.
 */

test.describe('Session mobile UX', () => {
  // Mobile viewport — under 768px to trip useIsMobile() / the
  // CSS media query for input font-size.
  test.use({ viewport: { width: 390, height: 844 } });
  test.describe.configure({ mode: 'serial' });

  test('SplitViewToggle appears on mobile and toggles which panel is visible', async ({ browser }) => {
    const { a, b } = await createAndClaimSession(browser);

    try {
      // Toggle group is rendered (role="group", aria-label "Trade view mode").
      const toggleGroup = a.page.getByRole('group', { name: /Trade view mode/i });
      await expect(toggleGroup).toBeVisible({ timeout: 5_000 });

      // Both buttons exist; "Both" is the default.
      const yoursBtn = toggleGroup.getByRole('button', { name: /^Yours$/i });
      const bothBtn = toggleGroup.getByRole('button', { name: /^Both$/i });
      const theirsBtn = toggleGroup.getByRole('button', { name: /^@/ });
      await expect(yoursBtn).toBeVisible();
      await expect(bothBtn).toBeVisible();
      await expect(theirsBtn).toBeVisible();
      // Default mode is "both" — its aria-pressed reflects that.
      await expect(bothBtn).toHaveAttribute('aria-pressed', 'true');

      // Tap "Yours": "Both" deactivates, "Yours" activates.
      await yoursBtn.click();
      await expect(yoursBtn).toHaveAttribute('aria-pressed', 'true');
      await expect(bothBtn).toHaveAttribute('aria-pressed', 'false');
      await expect(theirsBtn).toHaveAttribute('aria-pressed', 'false');

      // Tap the @-handle button (theirs).
      await theirsBtn.click();
      await expect(theirsBtn).toHaveAttribute('aria-pressed', 'true');
      await expect(yoursBtn).toHaveAttribute('aria-pressed', 'false');

      // Tap "Both" again — back to default.
      await bothBtn.click();
      await expect(bothBtn).toHaveAttribute('aria-pressed', 'true');

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });

  test('inputs render at 16px on mobile (iOS no-zoom guard)', async ({ browser }) => {
    const { a } = await createAndClaimSession(browser);

    try {
      // Surface the chat panel so its textarea is in the DOM.
      await a.page.getByRole('button', { name: /Chat & history/i }).first().click();
      const draft = a.page.getByPlaceholder(/Send a message/i);
      await expect(draft).toBeVisible({ timeout: 5_000 });

      // The CSS rule:
      //   @media (max-width: 767px) { textarea { font-size: 16px !important } }
      // applies. iOS Safari only auto-zooms on focus when font-size <
      // 16px, so this is the regression guard against that.
      const fontSize = await draft.evaluate(el => window.getComputedStyle(el).fontSize);
      expect(fontSize).toBe('16px');

      expect(filterConsoleErrors(a.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a]);
    }
  });
});
