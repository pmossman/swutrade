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
 * Covers /?trades=1 (history) + /?trade=<id> (detail) + the Cancel
 * flow. Sends a real proposal via the propose composer so the row
 * gets created with the right shape (delivery_status, ids, etc.),
 * then walks through history → detail → cancel.
 *
 * Server contracts around list/cancel are pinned in
 * trades-list-cancel.test.ts; this spec verifies the UI wires them
 * together correctly and surfaces the right states.
 */
test.describe('Trade history + detail + cancel', () => {
  test.describe.configure({ mode: 'serial' });

  let viewer: TestUser;
  let recipient: Awaited<ReturnType<typeof createSenderFixture>>;
  const cleanups: Array<() => Promise<void>> = [];

  test.beforeEach(async ({ context }) => {
    viewer = createIsolatedUser();
    await ensureTestUser(viewer);
    await signIn(context, viewer);

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

  test('send a proposal → history shows it → detail page renders → cancel flips status', async ({ page }) => {
    // Send a proposal via the composer.
    await page.goto(`/?propose=${recipient.handle}`);
    await waitForPricesLoaded(page);
    const proposeBar = page.getByTestId('propose-bar');
    await expect(proposeBar).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    // Auto-fill was removed — click Suggest so the trade has cards
    // before Send. Otherwise Send stays disabled. Send now opens a
    // confirm modal; click through it to actually POST.
    await page.getByTestId('propose-suggest').click();
    await page.getByTestId('propose-open-confirm').click();
    await expect(page.getByTestId('propose-confirm')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('confirm-send').click();
    await expect(proposeBar).toHaveAttribute('data-state', /^sent/, { timeout: 10_000 });

    // Look up the tradeId — we'll use it to compare against what
    // the UI surfaces in history + detail.
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
    const tradeId = row.id;
    cleanups.push(async () => {
      await db.delete(tradeProposals).where(eq(tradeProposals.id, tradeId)).catch(() => {});
    });

    // History: row should appear with the recipient's handle + a
    // pending status chip.
    await page.goto('/?trades=1');
    const history = page.getByTestId('trades-history');
    await expect(history).toBeVisible({ timeout: 10_000 });
    const handleText = page.getByText(`@${recipient.handle}`).first();
    await expect(handleText).toBeVisible();

    // Click into the row — should take us to /?trade=<id>.
    await handleText.click();
    await expect(page).toHaveURL(new RegExp(`[?&]trade=${tradeId}`));
    const detail = page.getByTestId('trade-detail');
    await expect(detail).toBeVisible({ timeout: 10_000 });
    // data-status attribute on the article reflects pending.
    await expect(page.locator('[data-testid="trade-detail"] [data-status]').first())
      .toHaveAttribute('data-status', 'pending');

    // Cancel.
    await page.getByRole('button', { name: /Cancel this proposal/i }).click();

    // DB should reflect cancelled state within the poll window.
    await expect.poll(async () => {
      const [fresh] = await db
        .select()
        .from(tradeProposals)
        .where(eq(tradeProposals.id, tradeId))
        .limit(1);
      return fresh?.status;
    }, { timeout: 5_000 }).toBe('cancelled');

    // UI should update to the cancelled state after the reload.
    await expect(page.locator('[data-testid="trade-detail"] [data-status]').first())
      .toHaveAttribute('data-status', 'cancelled', { timeout: 5_000 });
  });

  test('empty state renders when the user has no proposals', async ({ page }) => {
    await page.goto('/?trades=1');
    await expect(page.getByText(/No trade proposals yet/i))
      .toBeVisible({ timeout: 10_000 });
  });
});
