import { test, expect } from '@playwright/test';
import { filterConsoleErrors } from './_fixtures';
import { createIsolatedUser, ensureTestUser, signIn } from './helpers/auth';
import {
  addOneCardToSide,
  closeAllParticipants,
  createAndClaimSession,
  openSessionParticipant,
} from './helpers/sessions';

/**
 * Cross-device session sync — the same Discord user signed in on
 * two devices sees one canonical session state. Pinpoints the bug
 * surfaced by parker on 2026-04-30 ("opened my phone… showing
 * different lists than my laptop") and verifies the server-of-truth
 * model: no client-local diverges; both devices' polls converge on
 * the same `tradeSessions` row.
 *
 * Three browser contexts:
 *   - aDevice1 + aDevice2: same Discord user, two browsers.
 *   - bDevice: counterpart (different Discord user).
 *
 * Real-world parity: both A devices see the session as "yours",
 * both contexts mirror the same yourCards / theirCards. An edit
 * made on one A device propagates to the other through the 2.5s
 * poll, not through any client-local broadcast channel.
 */

test.describe('Session cross-device — same user, two browsers, one canonical state', () => {
  test.describe.configure({ mode: 'serial' });

  test('two devices for the same user see consistent state through the poll', async ({ browser }) => {
    const userA = createIsolatedUser();
    const userB = createIsolatedUser();
    await ensureTestUser(userA);
    await ensureTestUser(userB);

    // Three contexts. aDevice1 creates the session; bDevice claims;
    // aDevice2 then opens the same URL as userA.
    const aDevice1 = await openSessionParticipant(browser, { signedInAs: userA });
    let bDevice: Awaited<ReturnType<typeof openSessionParticipant>> | undefined;
    let aDevice2: Awaited<ReturnType<typeof openSessionParticipant>> | undefined;

    try {
      // aDevice1 opens an invite.
      await aDevice1.page.getByRole('button', { name: /Invite someone/i }).first().click();
      await expect(aDevice1.page).toHaveURL(/\/s\/[A-Z0-9]{8}$/, { timeout: 10_000 });
      const sessionUrl = aDevice1.page.url();

      // bDevice claims the open slot.
      bDevice = await openSessionParticipant(browser, { url: sessionUrl, signedInAs: userB });
      await bDevice.page.getByRole('button', { name: /Join this trade/i }).click();
      await expect(bDevice.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });

      // aDevice1 reloads to pick up the claim.
      await aDevice1.page.reload();
      await expect(aDevice1.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });

      // aDevice2 opens the same URL — should see itself as user_a too,
      // not the "Join this trade" preview.
      aDevice2 = await openSessionParticipant(browser, { url: sessionUrl, signedInAs: userA });
      await expect(aDevice2.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });
      // No "Join this trade" affordance — already a participant.
      await expect(aDevice2.page.getByRole('button', { name: /Join this trade/i })).toHaveCount(0);

      // Edit on aDevice1 → aDevice2 sees it via poll.
      await addOneCardToSide(aDevice1.page);
      await expect(aDevice2.page.getByText(/Luke Skywalker/i).first()).toBeVisible({ timeout: 8_000 });

      // Counterpart's view (bDevice) also sees aDevice1's add — confirms
      // the fan-out is shared, not just within-user.
      await expect(bDevice.page.getByText(/Luke Skywalker/i).first()).toBeVisible({ timeout: 8_000 });

      expect(filterConsoleErrors(aDevice1.errors)).toEqual([]);
      expect(filterConsoleErrors(aDevice2.errors)).toEqual([]);
      expect(filterConsoleErrors(bDevice.errors)).toEqual([]);
    } finally {
      const cleanups = [aDevice1];
      if (bDevice) cleanups.push(bDevice);
      if (aDevice2) cleanups.push(aDevice2);
      await closeAllParticipants(cleanups);
    }
  });

  test('ghost session URL is still accessible to the same ghost cookie after refresh', async ({ browser }) => {
    // Companion test for the ghost path — the bug's secondary cause
    // could affect ghosts too. A ghost cookie is sticky to the
    // browser context; we mostly want to confirm that reloading the
    // session URL doesn't lose the participant identity.
    const { a, b } = await createAndClaimSession(browser);

    try {
      // A reloads the session URL. Should re-render the canvas, not
      // a "Join this trade" CTA (the ghost cookie identifies them as
      // user_a already).
      await a.page.reload();
      await expect(a.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });
      await expect(a.page.getByRole('button', { name: /Join this trade/i })).toHaveCount(0);

      // Edit + verify B still sees it after A's reload.
      await addOneCardToSide(a.page);
      await expect(b.page.getByText(/Luke Skywalker/i).first()).toBeVisible({ timeout: 8_000 });

      expect(filterConsoleErrors(a.errors)).toEqual([]);
      expect(filterConsoleErrors(b.errors)).toEqual([]);
    } finally {
      await closeAllParticipants([a, b]);
    }
  });
});
