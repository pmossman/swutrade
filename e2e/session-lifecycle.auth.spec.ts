import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { filterConsoleErrors } from './_fixtures';

/**
 * Pins the shared-session lifecycle — create → claim → both-add →
 * both-confirm → settled — plus the terminal-cancelled read-only path.
 *
 * Why this file exists: the UX pass in commit 4b49c7e restructured
 * SessionView (controls moved below cards, readOnly TradeSide on the
 * counterpart half, terminal banners), and dogfooding caught three
 * bugs that CI missed because no integration test walks the happy
 * path. This is that coverage.
 *
 * Both participants are anonymous (ghost) users — `/api/sessions/
 * create-open` mints a ghost for the creator, `/api/sessions/:id/
 * claim` mints another for the joiner. No Discord OAuth needed, so
 * the spec is self-contained; the only runtime dep is the preview's
 * Postgres (shared with all other *.auth specs).
 *
 * Runs under `playwright.auth.config.ts` (matched by the `.auth.spec
 * .ts` suffix), which targets the Vercel preview URL in CI and is
 * excluded by local `npm run e2e`.
 */

interface Participant {
  context: BrowserContext;
  page: Page;
  errors: string[];
}

async function openParticipant(browser: Parameters<Parameters<typeof test>[1]>[0]['browser'], url = '/'): Promise<Participant> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(url);
  return { context, page, errors };
}

async function closeAll(participants: Participant[]): Promise<void> {
  for (const p of participants) {
    await p.context.close().catch(() => {});
  }
}

/**
 * Drive the "Add cards to Your side" picker and add a single card —
 * the same pattern e2e/trade-flow.spec.ts uses. The specific card
 * doesn't matter; Luke Skywalker Hero of Yavin (Standard) is the
 * stable seed cross-referenced across other specs.
 */
async function addOneCard(page: Page): Promise<void> {
  // The empty-side tile is "Add cards to Your side" — once cards are
  // present the footer button takes over under the same aria-label.
  await page.getByRole('button', { name: /Add cards to Your side/i }).first().click();
  const input = page.getByRole('textbox', { name: /Search cards/i }).first();
  await input.fill('luke jtl');
  const tile = page.getByRole('button', {
    name: /Luke Skywalker - Hero of Yavin \(Standard\)/i,
  }).first();
  await expect(tile).toBeVisible({ timeout: 10_000 });
  await tile.click();
  await page.getByRole('button', { name: 'Close search' }).first().click();
}

/**
 * Create an invite from context A and have context B claim it.
 * Returns both participants + the shared session URL.
 */
async function createAndClaim(
  browser: Parameters<Parameters<typeof test>[1]>[0]['browser'],
): Promise<{ a: Participant; b: Participant; sessionUrl: string }> {
  const a = await openParticipant(browser, '/');
  // Kick off the invite flow from anonymous context A.
  await a.page.getByRole('button', { name: /Invite someone/i }).first().click();
  await expect(a.page).toHaveURL(/\/s\/[A-Z0-9]{8}$/, { timeout: 10_000 });
  const sessionUrl = a.page.url();

  // Context B navigates to the shared URL and claims the open slot.
  const b = await openParticipant(browser, sessionUrl);
  const joinBtn = b.page.getByRole('button', { name: /Join this trade/i });
  await expect(joinBtn).toBeVisible({ timeout: 10_000 });
  await joinBtn.click();
  // Joined view: the shared chrome identifies the counterpart.
  await expect(b.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });

  // Context A reloads to pick up the claim — the open-slot invite
  // collapses into the full session canvas.
  await a.page.reload();
  await expect(a.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });

  return { a, b, sessionUrl };
}

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
      // Badge flips to green "You confirmed".
      await expect(a.page.getByText(/You confirmed/i)).toBeVisible({ timeout: 10_000 });
      // Button label swaps to "Waiting on @..." — matches the
      // `confirmLabel` branch in SessionActionBar.
      await expect(a.page.getByRole('button', { name: /Waiting on @/i })).toBeVisible();
      // Action-bar hint confirms the half-confirmed state copy.
      await expect(a.page.getByText(/You've confirmed\. Waiting on @/i)).toBeVisible();

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
    const a = await openParticipant(browser, '/');
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

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAll([a, b]);
    }
  });
});
