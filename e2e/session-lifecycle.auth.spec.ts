import { test, expect } from '@playwright/test';
import { filterConsoleErrors } from './_fixtures';
import {
  addOneCardToSide as addOneCard,
  closeAllParticipants as closeAll,
  createAndClaimSession as createAndClaim,
  openSessionParticipant as openParticipant,
} from './helpers/sessions';

/**
 * Pins the shared-session lifecycle — create → claim → both-add →
 * both-confirm → settled — plus the terminal-cancelled read-only path.
 *
 * Both participants are anonymous (ghost) users — `/api/sessions/
 * create-open` mints a ghost for the creator, `/api/sessions/:id/
 * claim` mints another for the joiner. No Discord OAuth needed, so
 * the spec is self-contained; the only runtime dep is the preview's
 * Postgres (shared with all other *.auth specs).
 *
 * Helpers live in `e2e/helpers/sessions.ts` so other session specs
 * can share the same primitives.
 */

test.describe('Shared session lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  test('create → claim → both add → both confirm → settled locks the canvas', async ({ browser }) => {
    const { a, b } = await createAndClaim(browser);

    try {
      // Each side adds one card to their own half. The exact card
      // doesn't matter — we only need *some* cards so Confirm enables.
      await addOneCard(a.page);
      await addOneCard(b.page);

      // Context A confirms first.
      await a.page.getByRole('button', { name: /^Confirm trade$/i }).click();
      // Identity-strip ConfirmBadge flips to "You confirmed".
      await expect(a.page.getByText(/You confirmed/i).first()).toBeVisible({ timeout: 10_000 });
      // CommitmentStrip above the cards announces viewer's commitment.
      await expect(a.page.getByText(/You've confirmed\./i).first()).toBeVisible();
      // Primary action swaps to "Unconfirm to edit" (gold outline).
      await expect(a.page.getByRole('button', { name: /^Unconfirm to edit$/i })).toBeVisible();

      // Context B needs a beat for the poll to surface @A's confirm,
      // then confirms themselves — this is the transition that flips
      // the session to settled.
      await b.page.reload();
      await expect(b.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });
      await b.page.getByRole('button', { name: /^Confirm trade$/i }).click();

      // Terminal-state assertions on context B (the closer).
      await expect(b.page.getByText(/Trade settled/i)).toBeVisible({ timeout: 15_000 });
      await expect(b.page.getByText(/Both of you confirmed on/i)).toBeVisible();
      // Active-session badge is replaced by the Settled badge.
      await expect(b.page.getByText(/Shared · both editing/i)).toHaveCount(0);
      // Action bar collapses entirely — no Confirm, no Cancel.
      await expect(b.page.getByRole('button', { name: /^Confirm trade$/i })).toHaveCount(0);
      await expect(b.page.getByRole('button', { name: /^Cancel trade$/i })).toHaveCount(0);
      // Both sides flip to readOnly — no Add Card affordance on
      // either half (tile nor footer button).
      await expect(b.page.getByRole('button', { name: /Add cards to /i })).toHaveCount(0);
      // Counterpart panel still renders the row with its line-total
      // price — proves readOnly TradeSide kept the breakdown intact.
      await expect(
        b.page.getByText(/Luke Skywalker - Hero of Yavin/i).first(),
      ).toBeVisible();

      // Context A (the first confirmer) eventually sees the same
      // terminal state after its next poll.
      await a.page.reload();
      await expect(a.page.getByText(/Trade settled/i)).toBeVisible({ timeout: 15_000 });
      await expect(a.page.getByRole('button', { name: /Add cards to /i })).toHaveCount(0);

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAll([a, b]);
    }
  });

  test('creator cancels an open-slot invite before anyone claims → terminal state renders', async ({ browser }) => {
    // Regression guard for the "cancel doesn't seem to work" bug:
    // `SessionView.openSlot` used to stay `true` after a cancel on
    // an unclaimed session (because the DB column `user_b_id` is
    // still null), so the client kept rendering the QR / "Cancel
    // this invitation" surface instead of the terminal banner. The
    // fix derives openSlot as "unclaimed AND active" so a cancelled
    // open invite transitions into the terminal banner path.
    const a = await openParticipant(browser);
    try {
      await a.page.getByRole('button', { name: /Invite someone/i }).first().click();
      await expect(a.page).toHaveURL(/\/s\/[A-Z0-9]{8}$/, { timeout: 10_000 });
      // Open-slot invite surface is visible — QR + "Share this QR or
      // link" heading + the "Cancel this invitation" link. "Share this
      // QR or link" is unique to the invite panel; the string
      // "Waiting for your counterpart" also shows up as the empty-state
      // label on the counterpart TradeSide after cancel, so we match on
      // the unique invite-panel copy instead.
      const invitePanelHeading = a.page.getByText(/Share this QR or link/i);
      await expect(invitePanelHeading).toBeVisible({ timeout: 10_000 });
      const cancelLink = a.page.getByRole('button', { name: /Cancel this invitation/i });
      await expect(cancelLink).toBeVisible();
      await cancelLink.click();

      // Post-cancel: invite surface is gone, terminal banner is up.
      await expect(a.page.getByText(/Trade cancelled/i)).toBeVisible({ timeout: 10_000 });
      await expect(invitePanelHeading).toHaveCount(0);
      await expect(a.page.getByRole('button', { name: /Cancel this invitation/i })).toHaveCount(0);

      expect(filterConsoleErrors(a.errors)).toEqual([]);
    } finally {
      await closeAll([a]);
    }
  });

  test('cancel from one side locks the canvas on both sides', async ({ browser }) => {
    const { a, b } = await createAndClaim(browser);

    try {
      // Auto-accept the window.confirm prompt that gates Cancel.
      a.page.on('dialog', d => void d.accept());
      await a.page.getByRole('button', { name: /^Cancel trade$/i }).click();

      // Canceller sees the terminal banner + loses all editing chrome.
      await expect(a.page.getByText(/Trade cancelled/i)).toBeVisible({ timeout: 10_000 });
      await expect(a.page.getByRole('button', { name: /Add cards to /i })).toHaveCount(0);
      await expect(a.page.getByRole('button', { name: /^Confirm trade$/i })).toHaveCount(0);
      await expect(a.page.getByRole('button', { name: /^Cancel trade$/i })).toHaveCount(0);

      // Other side sees the cancelled state after a reload — proves
      // the transition propagated through the server, not just
      // client-local state.
      await b.page.reload();
      await expect(b.page.getByText(/Trade cancelled/i)).toBeVisible({ timeout: 10_000 });
      await expect(b.page.getByRole('button', { name: /Add cards to /i })).toHaveCount(0);

      // Both sides see the escape link inside the terminal banner.
      // Ghost participants land on "Back to home" (they don't have
      // a My Trades surface). The link is inside the banner so
      // asserting visibility is sufficient — click-through would
      // navigate away from the canvas.
      await expect(a.page.getByRole('link', { name: /Back to home/i })).toBeVisible();
      await expect(b.page.getByRole('link', { name: /Back to home/i })).toBeVisible();

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAll([a, b]);
    }
  });

  test('confirmer can unconfirm to re-edit before the counterpart confirms', async ({ browser }) => {
    const { a, b } = await createAndClaim(browser);

    try {
      await addOneCard(a.page);
      await addOneCard(b.page);

      // A confirms.
      await a.page.getByRole('button', { name: /^Confirm trade$/i }).click();
      await expect(a.page.getByRole('button', { name: /^Unconfirm to edit$/i })).toBeVisible({ timeout: 10_000 });
      // Your-side Add-cards affordance locks (readOnly gate on the
      // viewer panel when confirmedByViewer). Counterpart's side is
      // always readOnly so its add button was never there.
      await expect(a.page.getByRole('button', { name: /Add cards to Your side/i })).toHaveCount(0);

      // Unconfirm — back to editable.
      await a.page.getByRole('button', { name: /^Unconfirm to edit$/i }).click();
      await expect(a.page.getByRole('button', { name: /^Confirm trade$/i })).toBeVisible({ timeout: 10_000 });
      // CommitmentStrip gone (viewer no longer confirmed).
      await expect(a.page.getByText(/You've confirmed\./i)).toHaveCount(0);
      // Viewer side's Add-cards affordance back.
      await expect(a.page.getByRole('button', { name: /Add cards to Your side/i }).first()).toBeVisible();

      // Session is still 'active' from B's perspective — can still
      // confirm and settle on the other side of an unconfirm.
      await b.page.reload();
      await expect(b.page.getByRole('button', { name: /^Confirm trade$/i })).toBeVisible({ timeout: 10_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAll([a, b]);
    }
  });
});
