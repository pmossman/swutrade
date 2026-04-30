import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '@playwright/test';

/**
 * Pins the Phase 5b session-collaboration slice end-to-end:
 *   - chat round-trip via the timeline panel
 *   - cross-side suggest → counterpart accept (cards land on
 *     counterpart's side)
 *   - suggest → counterpart edits independently to fulfill →
 *     suggestion auto-dismisses with reason 'satisfied'
 *   - revert proposed by one side → accepted by the counterpart
 *     (double-sided confirm)
 *
 * Both participants are ghost users via the open-slot QR flow —
 * same pattern as session-lifecycle.auth.spec.ts. No Discord OAuth
 * needed; the spec is self-contained against the preview's Postgres.
 */

interface Participant {
  context: BrowserContext;
  page: Page;
}

async function openParticipant(browser: Parameters<Parameters<typeof test>[1]>[0]['browser'], url = '/'): Promise<Participant> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    try { window.localStorage.setItem('swu.tour.dismissedAt', 'suppressed-by-e2e'); } catch {}
  });
  await page.goto(url);
  return { context, page };
}

async function closeAll(parts: Participant[]): Promise<void> {
  for (const p of parts) {
    await p.context.close().catch(() => {});
  }
}

/**
 * Drive the "Add cards to Your side" picker and add a single card.
 * Mirrors the helper in session-lifecycle.auth.spec.ts so the
 * canonical seed (Luke Skywalker - Hero of Yavin) stays consistent
 * across specs.
 */
async function addOneCard(page: Page, query: string = 'luke jtl', cardName: RegExp = /Luke Skywalker - Hero of Yavin \(Standard\)/i): Promise<void> {
  await page.getByRole('button', { name: /Add cards to Your side/i }).first().click();
  const input = page.getByRole('textbox', { name: /Search cards/i }).first();
  await input.fill(query);
  const tile = page.getByRole('button', { name: cardName }).first();
  await expect(tile).toBeVisible({ timeout: 10_000 });
  await tile.click();
  await page.getByRole('button', { name: 'Close search' }).first().click();
}

async function createAndClaim(
  browser: Parameters<Parameters<typeof test>[1]>[0]['browser'],
): Promise<{ a: Participant; b: Participant; sessionUrl: string }> {
  const a = await openParticipant(browser, '/');
  await a.page.getByRole('button', { name: /Invite someone/i }).first().click();
  await expect(a.page).toHaveURL(/\/s\/[A-Z0-9]{8}$/, { timeout: 10_000 });
  const sessionUrl = a.page.url();

  const b = await openParticipant(browser, sessionUrl);
  const joinBtn = b.page.getByRole('button', { name: /Join this trade/i });
  await expect(joinBtn).toBeVisible({ timeout: 10_000 });
  await joinBtn.click();
  await expect(b.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });

  await a.page.reload();
  await expect(a.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });

  return { a, b, sessionUrl };
}

test.describe('Session collaboration — chat, suggestions, revert', () => {
  test.describe.configure({ mode: 'serial' });

  test('chat round-trip: A sends, B sees in their timeline within one poll', async ({ browser }) => {
    const { a, b } = await createAndClaim(browser);

    try {
      // A opens the timeline + sends a chat message.
      await a.page.getByRole('button', { name: /^Activity/ }).first().click();
      const draft = a.page.getByPlaceholder(/Send a message/i);
      await expect(draft).toBeVisible({ timeout: 5_000 });
      await draft.fill('hey, want to balance things out?');
      await a.page.getByRole('button', { name: /^Send$/ }).click();

      // B opens their timeline. Within the 2.5s poll window, the
      // chat bubble should arrive.
      await b.page.getByRole('button', { name: /^Activity/ }).first().click();
      await expect(
        b.page.getByText(/hey, want to balance things out\?/),
      ).toBeVisible({ timeout: 8_000 });
    } finally {
      await closeAll([a, b]);
    }
  });

  test('suggest → counterpart accepts: cards land on the counterpart side', async ({ browser }) => {
    const { a, b } = await createAndClaim(browser);

    try {
      // The "+ Suggest changes" button now lives inside the
      // counterpart's panel header (so the suggestion is anchored
      // visually to the side it would affect).
      await a.page.getByRole('button', { name: /^\+ Suggest changes$/ }).click();
      await expect(a.page.getByText(/Suggest changes/i).first()).toBeVisible({ timeout: 5_000 });

      // Pick Luke (Standard) — composer uses the standard ListCardPicker.
      const input = a.page.getByRole('textbox', { name: /Search cards/i }).first();
      await input.fill('luke jtl');
      const tile = a.page.getByRole('button', {
        name: /Luke Skywalker - Hero of Yavin \(Standard\).*to suggestion/i,
      }).first();
      await expect(tile).toBeVisible({ timeout: 10_000 });
      await tile.click();

      // Send the suggestion.
      await a.page.getByRole('button', { name: /Send suggestion/i }).click();

      // Suggestion now appears as a collapsed pill. A sees their
      // outgoing pill ("You suggested +1") inside the counterpart's
      // panel; the button's aria-label carries the verb so we don't
      // depend on flex-child text concatenation.
      await expect(
        a.page.getByRole('button', { name: /You suggested/i }).first(),
      ).toBeVisible({ timeout: 5_000 });

      // B sees an incoming pill in their own panel ("@<handle>
      // suggests +1"). The pill is collapsed by default; click to
      // expand, then Accept.
      const incomingPill = b.page.getByRole('button', { name: /suggests/i }).first();
      await expect(incomingPill).toBeVisible({ timeout: 8_000 });
      await incomingPill.click();
      await b.page.getByRole('button', { name: /^Accept$/ }).first().click();

      // The card lands on B's side — visible in the trade canvas.
      await expect(b.page.getByText(/Luke Skywalker - Hero of Yavin/i).first()).toBeVisible({ timeout: 8_000 });
      // Suggestion pill clears on both sides.
      await expect(b.page.getByRole('button', { name: /suggests/i })).toHaveCount(0, { timeout: 8_000 });
      await expect(a.page.getByRole('button', { name: /You suggested/i })).toHaveCount(0, { timeout: 8_000 });
    } finally {
      await closeAll([a, b]);
    }
  });

  test('suggest auto-dismisses when the counterpart fulfills via direct edit', async ({ browser }) => {
    const { a, b } = await createAndClaim(browser);

    try {
      // A opens the suggest composer + suggests Luke for B.
      await a.page.getByRole('button', { name: /^\+ Suggest changes$/ }).click();
      const input = a.page.getByRole('textbox', { name: /Search cards/i }).first();
      await input.fill('luke jtl');
      const tile = a.page.getByRole('button', {
        name: /Luke Skywalker - Hero of Yavin \(Standard\).*to suggestion/i,
      }).first();
      await expect(tile).toBeVisible({ timeout: 10_000 });
      await tile.click();
      await a.page.getByRole('button', { name: /Send suggestion/i }).click();

      // B sees the pending pill in their own panel.
      await expect(
        b.page.getByRole('button', { name: /suggests/i }).first(),
      ).toBeVisible({ timeout: 8_000 });

      // B independently adds Luke to their side via the normal flow.
      // After the edit, the auto-sweep marks the suggestion satisfied
      // and dismisses it.
      await addOneCard(b.page);

      // Pill clears from both sides on poll.
      await expect(b.page.getByRole('button', { name: /suggests/i })).toHaveCount(0, { timeout: 8_000 });
      await expect(a.page.getByRole('button', { name: /You suggested/i })).toHaveCount(0, { timeout: 8_000 });
    } finally {
      await closeAll([a, b]);
    }
  });

  test('revert: A proposes revert to a past snapshot; B accepts; both sides flip', async ({ browser }) => {
    const { a, b } = await createAndClaim(browser);

    try {
      // Both sides do an edit so there's a snapshot to revert to.
      await addOneCard(a.page);
      await addOneCard(b.page);

      // Wait for the post-edit poll to reach A so its timeline carries
      // the snapshot events.
      await a.page.waitForTimeout(3_000);

      // A opens the timeline; the most-recent edit-snapshot row has
      // a "↶ Revert here" affordance.
      await a.page.getByRole('button', { name: /^Activity/ }).first().click();
      const revertBtns = a.page.getByRole('button', { name: /↶ Revert here/i });
      await expect(revertBtns.first()).toBeVisible({ timeout: 8_000 });
      // Click the OLDEST visible revert (last in DOM order — events
      // render top-to-bottom newest-first reversed; so .last() is the
      // earliest snapshot, before either side added cards).
      const all = await revertBtns.all();
      // Grab the second-to-last revert (after A's edit, before B's).
      // Falls back to .last() when there aren't enough snapshots yet.
      const target = all[all.length - 2] ?? all[all.length - 1];
      await target.click();

      // A's revert banner appears (collapsed pill above the canvas).
      await expect(a.page.getByText(/proposed reverting both sides/i)).toBeVisible({ timeout: 5_000 });

      // B sees the same pill. Tap to expand, then Accept.
      const bPill = b.page.getByRole('button', { name: /proposed reverting both sides/i });
      await expect(bPill).toBeVisible({ timeout: 8_000 });
      await bPill.click();
      await b.page.getByRole('button', { name: /↶ Accept revert/i }).click();

      // Suggestion clears.
      await expect(b.page.getByText(/proposed reverting both sides/i)).toHaveCount(0, { timeout: 8_000 });
      await expect(a.page.getByText(/proposed reverting both sides/i)).toHaveCount(0, { timeout: 8_000 });
    } finally {
      await closeAll([a, b]);
    }
  });
});
