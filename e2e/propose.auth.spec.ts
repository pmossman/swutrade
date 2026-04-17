import { test, expect } from '@playwright/test';
import {
  signIn,
  createIsolatedUser,
  ensureTestUser,
  cleanupTestUser,
  createSenderFixture,
  seedUserLists,
  type TestUser,
} from './helpers/auth';
import { waitForPricesLoaded } from './helpers/waitForApp';

/**
 * Covers the propose flow end-to-end: ProfileView button →
 * `/?propose=<handle>` → ProposeBar → /api/trades/propose →
 * `trade_proposals` row.
 *
 * Server validation is pinned in trades-propose.test.ts; this
 * spec verifies the UI wires those pieces together correctly and
 * that ProposeBar's auto-match + send actually persists a row.
 */
test.describe('Trade proposal flow', () => {
  test.describe.configure({ mode: 'serial' });
  let viewer: TestUser;
  let recipient: Awaited<ReturnType<typeof createSenderFixture>>;
  const cleanups: Array<() => Promise<void>> = [];

  test.beforeEach(async ({ context }) => {
    viewer = createIsolatedUser();
    await ensureTestUser(viewer);
    await signIn(context, viewer);

    // Recipient with a want that the viewer can fulfill + something
    // the viewer wants. Product 617180 is Luke JTL Standard; the
    // viewer seeds Luke in their available to trigger the match.
    recipient = await createSenderFixture({
      wants: [{ familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1 }],
      available: [{ productId: '617180', qty: 1 }],
    });
    cleanups.push(() => recipient.cleanup());

    cleanups.push(await seedUserLists(viewer.userId, {
      available: [{ productId: '617180', qty: 1 }],
      wants: [{ familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1 }],
    }));
  });

  test.afterEach(async () => {
    for (const fn of cleanups.reverse()) await fn();
    cleanups.length = 0;
    await cleanupTestUser(viewer);
  });

  test('ProfileView shows Propose button; clicking navigates to composer and sends creates a trade_proposals row', async ({ page }) => {
    // Step 1: ProfileView has the Propose button (we're signed in + viewing someone else).
    await page.goto(`/u/${recipient.handle}`);
    await expect(page.getByRole('link', { name: /Propose a trade/i }))
      .toBeVisible({ timeout: 10_000 });

    // Step 2: clicking takes us to /?propose=<handle> with the bar rendered.
    await page.getByRole('link', { name: /Propose a trade/i }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]propose=${recipient.handle}`));
    await waitForPricesLoaded(page);

    const bar = page.getByTestId('propose-bar');
    await expect(bar).toBeVisible({ timeout: 10_000 });
    // Matchmaker + auto-apply should leave the bar in 'ready' state
    // (profile loaded, cards applied). If it stays in 'loading-profile'
    // the fetch never completed.
    await expect(bar).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });

    // Step 3: open the note disclosure and type a message. The
    // server persists this on the trade_proposals row and it shows
    // in the recipient's DM embed description.
    const noteMessage = 'Ping me on Discord about meetup time — e2e note';
    await page.getByRole('button', { name: /Add a note/i }).click();
    await page.getByLabel(/Proposal note/i).fill(noteMessage);

    // Step 4: click Send and confirm the success state lands.
    // The recipient is seeded via createSenderFixture with a
    // synthetic discordId that Discord rejects, so the DM delivery
    // fails and the bar lands in `sent-undelivered`. The trade row
    // still exists — we care about the row, not the transport.
    // Regex matches both `sent` and `sent-undelivered`.
    await page.getByRole('button', { name: /Send proposal/i }).click();
    await expect(bar).toHaveAttribute('data-state', /^sent/, { timeout: 10_000 });

    // Step 5: a row actually exists in trade_proposals for this
    // viewer → recipient pair AND the note was persisted verbatim.
    const { getDb } = await import('../lib/db.js');
    const { tradeProposals } = await import('../lib/schema.js');
    const { and, eq } = await import('drizzle-orm');
    const db = getDb();
    const [row] = await db
      .select()
      .from(tradeProposals)
      .where(and(
        eq(tradeProposals.proposerUserId, viewer.userId),
        eq(tradeProposals.recipientUserId, recipient.userId),
      ))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.status).toBe('pending');
    expect(row.offeringCards.length + row.receivingCards.length).toBeGreaterThan(0);
    expect(row.message).toBe(noteMessage);

    // Cleanup: the trade_proposals row cascades with the recipient
    // user delete, but be defensive — test helpers don't know about
    // this table yet.
    cleanups.push(async () => {
      await db.delete(tradeProposals)
        .where(eq(tradeProposals.proposerUserId, viewer.userId))
        .catch(() => {});
    });
  });

  test('Propose button is absent when viewing your own profile', async ({ page }) => {
    await page.goto(`/u/${viewer.handle}`);
    // Wait for profile to load at all.
    await expect(page.getByText(`@${viewer.handle}`).first())
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: /Propose a trade/i }))
      .toHaveCount(0);
  });
});
