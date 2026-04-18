import { test, expect } from '@playwright/test';
import {
  signIn,
  createIsolatedUser,
  ensureTestUser,
  cleanupTestUser,
  seedUserLists,
} from './helpers/auth';
import { waitForPricesLoaded } from './helpers/waitForApp';

/**
 * End-to-end counter flow — the real chain the user actually walks:
 * two separate signed-in users, a proposal from one, a counter from
 * the other via the web composer, and the resulting DB state shows
 * the original transitioned to `countered` and a new row linked via
 * `counter_of_id`.
 *
 * Uses two BrowserContexts (one per user) so session cookies don't
 * collide. Each context gets its own sign-in.
 */
test.describe('Counter flow', () => {
  test.describe.configure({ mode: 'serial' });

  test('proposer sends original → recipient composes counter via /?counter=<id> → chain reflects in DB', async ({ browser }) => {
    const proposer = createIsolatedUser();
    const recipient = createIsolatedUser();
    await ensureTestUser(proposer);
    await ensureTestUser(recipient);

    // Both users need overlapping lists so the matchmaker on
    // ProposeBar seeds something actionable. Luke (jump-to-
    // lightspeed::luke-skywalker-hero-of-yavin, productId 617180)
    // is a stable card seeded across other e2e specs.
    const viewerListsCleanup = await seedUserLists(proposer.userId, {
      available: [{ productId: '617180', qty: 1 }],
      wants: [{ familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1 }],
    });
    const recipientListsCleanup = await seedUserLists(recipient.userId, {
      available: [{ productId: '617180', qty: 1 }],
      wants: [{ familyId: 'jump-to-lightspeed::luke-skywalker-hero-of-yavin', qty: 1 }],
    });

    const { getDb } = await import('../lib/db.js');
    const { tradeProposals } = await import('../lib/schema.js');
    const { and, eq } = await import('drizzle-orm');
    const db = getDb();

    // --- Step 1: proposer sends an original proposal to recipient.
    const ctx1 = await browser.newContext();
    try {
      await signIn(ctx1, proposer);
      const page1 = await ctx1.newPage();
      await page1.goto(`/?propose=${recipient.handle}`);
      await waitForPricesLoaded(page1);

      const proposeBar = page1.getByTestId('propose-bar');
      await expect(proposeBar).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
      // Auto-fill was removed — click Suggest so the trade has cards
      // before Send. Otherwise the Send button stays disabled. Send
      // now opens a confirm modal; click through it to actually POST.
      await page1.getByTestId('propose-suggest').click();
      await page1.getByTestId('propose-open-confirm').click();
      await expect(page1.getByTestId('propose-confirm')).toBeVisible({ timeout: 5_000 });
      await page1.getByTestId('confirm-send').click();
      await expect(proposeBar).toHaveAttribute('data-state', /^sent/, { timeout: 10_000 });
    } finally {
      await ctx1.close();
    }

    const [originalRow] = await db
      .select()
      .from(tradeProposals)
      .where(and(
        eq(tradeProposals.proposerUserId, proposer.userId),
        eq(tradeProposals.recipientUserId, recipient.userId),
      ))
      .limit(1);
    expect(originalRow).toBeTruthy();
    expect(originalRow.status).toBe('pending');
    const originalId = originalRow.id;

    // --- Step 2: recipient opens /?counter=<originalId> in their
    // own browser context, confirms the composer seeds, and sends.
    const ctx2 = await browser.newContext();
    try {
      await signIn(ctx2, recipient);
      const page2 = await ctx2.newPage();
      await page2.goto(`/?counter=${originalId}`);
      await waitForPricesLoaded(page2);

      const counterBar = page2.getByTestId('counter-bar');
      await expect(counterBar).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
      await page2.getByRole('button', { name: /Send counter/i }).click();
      await expect(counterBar).toHaveAttribute('data-state', /^sent/, { timeout: 10_000 });
    } finally {
      await ctx2.close();
    }

    // --- Step 3: DB reflects the chain.
    const [origAfter] = await db
      .select()
      .from(tradeProposals)
      .where(eq(tradeProposals.id, originalId))
      .limit(1);
    expect(origAfter.status).toBe('countered');
    expect(origAfter.respondedAt).not.toBeNull();

    const [counterRow] = await db
      .select()
      .from(tradeProposals)
      .where(eq(tradeProposals.counterOfId, originalId))
      .limit(1);
    expect(counterRow).toBeTruthy();
    expect(counterRow.proposerUserId).toBe(recipient.userId);
    expect(counterRow.recipientUserId).toBe(proposer.userId);
    expect(counterRow.status).toBe('pending');

    // Cleanup: delete both rows + both users. Do children before
    // parents because counter_of_id has an on-delete-set-null rule
    // that would leave the counter with a null pointer if we
    // reversed the order.
    await db.delete(tradeProposals).where(eq(tradeProposals.id, counterRow.id)).catch(() => {});
    await db.delete(tradeProposals).where(eq(tradeProposals.id, originalId)).catch(() => {});
    await viewerListsCleanup();
    await recipientListsCleanup();
    await cleanupTestUser(proposer);
    await cleanupTestUser(recipient);
  });
});
