import { test, expect } from '@playwright/test';
import { filterConsoleErrors } from './_fixtures';
import { createIsolatedUser, ensureTestUser } from './helpers/auth';
import {
  addOneCardToSide,
  closeAllParticipants,
  createAndClaimSession,
  openSessionParticipant,
} from './helpers/sessions';

/**
 * Phase D — Discord-identity coverage. Uses the existing `signIn()`
 * helper (iron-session direct cookie sealing) so we don't need a
 * separate `/api/test/auth-login` endpoint.
 *
 * Pins:
 *   1. Discord-to-Discord — two Discord users in a session, chat
 *      attribution carries each user's handle ("@<handle>") on the
 *      counterpart's view.
 *   2. Anon claims Discord-created session — Discord user A creates
 *      an open-slot session; ghost B claims it. The mixed-identity
 *      session functions for edits + chat across the asymmetry.
 */

test.describe('Session Discord identities', () => {
  test.describe.configure({ mode: 'serial' });

  test('Discord-to-Discord — chat attribution shows the counterpart handle', async ({ browser }) => {
    const userA = createIsolatedUser();
    const userB = createIsolatedUser();
    await ensureTestUser(userA);
    await ensureTestUser(userB);

    const { a, b } = await createAndClaimSession(browser, { aAs: userA, bAs: userB });

    try {
      // A sends a message.
      await a.page.getByRole('button', { name: /Chat & history/i }).first().click();
      const aDraft = a.page.getByPlaceholder(/Send a message/i);
      await expect(aDraft).toBeVisible({ timeout: 5_000 });
      await aDraft.fill('hello from A');
      await a.page.getByRole('button', { name: /^Send$/ }).click();

      // B opens timeline, expects to see A's message attributed via
      // the panel's "with @<handle>" header AND the counterpart-side
      // chat bubble.
      await b.page.getByRole('button', { name: /Chat & history/i }).first().click();
      // Use exact-match text to disambiguate from the breadcrumb's
      // "Trade with @<handle>" — both contain the same handle but
      // only the panel header is exactly "with @<handle>".
      await expect(
        b.page.getByText(`with @${userA.handle}`, { exact: true }),
      ).toBeVisible({ timeout: 5_000 });
      // Chat bubble body visible.
      await expect(b.page.getByText(/hello from A/i)).toBeVisible({ timeout: 8_000 });

      // Round-trip: B replies, A sees the body.
      const bDraft = b.page.getByPlaceholder(/Send a message/i);
      await bDraft.fill('hi from B');
      await b.page.getByRole('button', { name: /^Send$/ }).click();
      await expect(a.page.getByText(/hi from B/i)).toBeVisible({ timeout: 8_000 });
      // A's panel header reflects @userB.handle.
      await expect(
        a.page.getByText(`with @${userB.handle}`, { exact: true }),
      ).toBeVisible({ timeout: 5_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });

  test('Anon claims a Discord-created session — mixed-identity edits + chat work', async ({ browser }) => {
    const userA = createIsolatedUser();
    await ensureTestUser(userA);

    // A is Discord. B is ghost (no signedInAs).
    const a = await openSessionParticipant(browser, { signedInAs: userA });

    try {
      await a.page.getByRole('button', { name: /Invite someone/i }).first().click();
      await expect(a.page).toHaveURL(/\/s\/[A-Z0-9]{8}$/, { timeout: 10_000 });
      const sessionUrl = a.page.url();

      // Ghost B navigates to the URL and claims.
      const b = await openSessionParticipant(browser, { url: sessionUrl });
      try {
        await b.page.getByRole('button', { name: /Join this trade/i }).click();
        await expect(b.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });

        // A reloads to pick up the claim.
        await a.page.reload();
        await expect(a.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });

        // Cross-side edits work: A adds Luke, B sees it.
        await addOneCardToSide(a.page);
        await expect(b.page.getByText(/Luke Skywalker/i).first()).toBeVisible({ timeout: 8_000 });

        // Chat works in the asymmetric session: A sends, B sees.
        await a.page.getByRole('button', { name: /Chat & history/i }).first().click();
        const aDraft = a.page.getByPlaceholder(/Send a message/i);
        await aDraft.fill('hello ghost');
        await a.page.getByRole('button', { name: /^Send$/ }).click();
        await b.page.getByRole('button', { name: /Chat & history/i }).first().click();
        await expect(b.page.getByText(/hello ghost/i)).toBeVisible({ timeout: 8_000 });

        expect(filterConsoleErrors(a.errors)).toEqual([]);
        expect(filterConsoleErrors(b.errors)).toEqual([]);
      } finally {
        await closeAllParticipants([b]);
      }
    } finally {
      await closeAllParticipants([a]);
    }
  });
});
