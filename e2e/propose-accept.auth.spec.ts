import { test, expect } from '@playwright/test';
import { createPrivateKey, type KeyObject } from 'node:crypto';
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
import { signInteraction, buildButtonClickPayload } from './helpers/discordSign';

/**
 * Closes the Phase 4c Slice 3 coverage gap — exercises the full
 * compose → send → click → DB-updated loop by simulating the
 * Discord button-click POST with a known test keypair.
 *
 * Why this test exists: Discord's real button clicks can only be
 * issued by a human via the Discord client. That makes the second
 * half of the proposal lifecycle invisible to Playwright unless we
 * synthesize the signed webhook ourselves. This spec does that.
 *
 * Runtime requirement: the preview deploy must have
 * `DISCORD_APP_PUBLIC_KEY_TEST` set to the raw-hex public key that
 * matches `DISCORD_TEST_PRIVATE_KEY_PEM` available to the test
 * process. The server accepts signatures from either the real
 * Discord key or this test key (see api/bot.ts). If either env is
 * missing we skip with a clear message rather than silently pass.
 */

function loadTestPrivateKey(): KeyObject | null {
  const pem = process.env.DISCORD_TEST_PRIVATE_KEY_PEM;
  if (!pem) return null;
  try {
    return createPrivateKey({ key: pem, format: 'pem' });
  } catch (err) {
    // Bad PEM — better to fail loudly than silently skip, because
    // "CI green" is the promise we're trying to keep.
    throw new Error(`DISCORD_TEST_PRIVATE_KEY_PEM is not valid PEM: ${err instanceof Error ? err.message : String(err)}`);
  }
}

test.describe('Signed button interaction (synthetic Discord webhook)', () => {
  test.describe.configure({ mode: 'serial' });

  const privateKey = loadTestPrivateKey();
  const hasTestKey = privateKey !== null;
  if (!hasTestKey) {
    // Dormant skip: the spec ships but only activates once the
    // keypair is provisioned. Message makes the setup obvious.
    test.skip(true, 'DISCORD_TEST_PRIVATE_KEY_PEM not set — provision a test keypair + set DISCORD_APP_PUBLIC_KEY_TEST on Preview to activate.');
  }

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

  test('proposer sends → recipient Accept click flips DB row to accepted + server returns type-7 UPDATE_MESSAGE', async ({ page, request }) => {
    // Step 1: compose + send a proposal via the browser.
    await page.goto(`/?propose=${recipient.handle}`);
    await waitForPricesLoaded(page);
    const bar = page.getByTestId('propose-bar');
    await expect(bar).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await page.getByRole('button', { name: /Send proposal/i }).click();
    // Either 'sent' (real DM landed — unlikely with a fake discord
    // id) or 'sent-undelivered'. Both are OK; the trade row exists.
    await expect(bar).toHaveAttribute('data-state', /sent/, { timeout: 10_000 });

    // Step 2: look up the trade id we just created. The bar exposes
    // the id in a data-trade-id attribute? Not yet — grab it from
    // the DB by (proposer, recipient).
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
    const tradeId = row.id;
    cleanups.push(async () => {
      await db.delete(tradeProposals).where(eq(tradeProposals.id, tradeId)).catch(() => {});
    });

    // Step 3: synthesize a signed "Accept" button-click interaction
    // from the recipient. The `clickerDiscordId` must match the
    // recipient's discord_id — createSenderFixture uses userId as
    // discordId so that's the value here.
    const payload = buildButtonClickPayload({
      customId: `trade-proposal:${tradeId}:accept`,
      clickerDiscordId: recipient.userId,
    });
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signInteraction({ body, timestamp, privateKey: privateKey! });

    const interactionRes = await request.post('/api/bot/interactions', {
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': signature,
        'x-signature-timestamp': timestamp,
      },
      data: body,
    });

    // Step 4: server returns type 7 (UPDATE_MESSAGE) with stripped
    // components — matches the unit-test contract but now through
    // the real signature-verify + dispatch path on the deployed
    // preview.
    expect(interactionRes.status()).toBe(200);
    const json = await interactionRes.json() as { type?: number; data?: { components?: unknown[] } };
    expect(json.type).toBe(7);
    expect(json.data?.components).toEqual([]);

    // Step 5: DB row reflects the transition.
    const [updated] = await db
      .select()
      .from(tradeProposals)
      .where(eq(tradeProposals.id, tradeId))
      .limit(1);
    expect(updated.status).toBe('accepted');
    expect(updated.respondedAt).not.toBeNull();
  });

  test('decline flips status to declined and refuses a second click from a non-recipient', async ({ page, request }) => {
    await page.goto(`/?propose=${recipient.handle}`);
    await waitForPricesLoaded(page);
    const bar = page.getByTestId('propose-bar');
    await expect(bar).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await page.getByRole('button', { name: /Send proposal/i }).click();
    await expect(bar).toHaveAttribute('data-state', /sent/, { timeout: 10_000 });

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
    const tradeId = row.id;
    cleanups.push(async () => {
      await db.delete(tradeProposals).where(eq(tradeProposals.id, tradeId)).catch(() => {});
    });

    // Intruder tries first — should be rejected with an ephemeral.
    const intruderPayload = buildButtonClickPayload({
      customId: `trade-proposal:${tradeId}:decline`,
      clickerDiscordId: `intruder-${Date.now()}`,
    });
    const intruderBody = JSON.stringify(intruderPayload);
    const intruderTs = Math.floor(Date.now() / 1000).toString();
    const intruderSig = signInteraction({
      body: intruderBody,
      timestamp: intruderTs,
      privateKey: privateKey!,
    });
    const intruderRes = await request.post('/api/bot/interactions', {
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': intruderSig,
        'x-signature-timestamp': intruderTs,
      },
      data: intruderBody,
    });
    const intruderJson = await intruderRes.json() as { type?: number; data?: { flags?: number } };
    expect(intruderJson.type).toBe(4); // ephemeral
    expect(intruderJson.data?.flags).toBe(64);

    // DB unchanged.
    const [afterIntruder] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
    expect(afterIntruder.status).toBe('pending');

    // Real recipient declines — should succeed.
    const acceptPayload = buildButtonClickPayload({
      customId: `trade-proposal:${tradeId}:decline`,
      clickerDiscordId: recipient.userId,
    });
    const acceptBody = JSON.stringify(acceptPayload);
    const acceptTs = Math.floor(Date.now() / 1000).toString();
    const acceptSig = signInteraction({
      body: acceptBody,
      timestamp: acceptTs,
      privateKey: privateKey!,
    });
    const acceptRes = await request.post('/api/bot/interactions', {
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': acceptSig,
        'x-signature-timestamp': acceptTs,
      },
      data: acceptBody,
    });
    expect(acceptRes.status()).toBe(200);
    const acceptJson = await acceptRes.json() as { type?: number };
    expect(acceptJson.type).toBe(7);

    const [finalRow] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, tradeId)).limit(1);
    expect(finalRow.status).toBe('declined');
  });
});
