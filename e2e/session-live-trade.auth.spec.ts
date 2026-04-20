import { test, expect } from '@playwright/test';

/**
 * Covers the Phase 5b "Live trade" flow end-to-end at the browser
 * layer. Two bugs shipped through CI before this spec existed:
 *
 *   1. vercel.json lacked a `/s/:id` rewrite, so every session URL
 *      404'd in the browser even though the API endpoint was fine.
 *      Unit tests and typecheck had no way to see this — route
 *      config is outside their reach.
 *
 *   2. react-qr-code's CJS default export didn't interop with Vite's
 *      ESM import shim. Types were happy; runtime crashed on first
 *      mount with "Element type is invalid — Check OpenSlotInvite."
 *      No test mounts a React component directly, so nothing caught
 *      it pre-ship.
 *
 * Both classes of bug are browser-layer. This spec is the minimum
 * defence: visit the route, assert the component tree rendered,
 * assert zero console errors. Any future regression to the session
 * routing / module graph fails here.
 */
test.describe('Live trade session', () => {
  test('GET /s/<unknown> renders the app chrome, not a 404', async ({ page }) => {
    // Visiting any /s/<code> directly — even a made-up one — must
    // serve the SPA index so client routing can render the Not
    // Found state. The bug was that Vercel's default behaviour for
    // an unrewritten path is a literal 404 page from the platform,
    // so the SPA never boots and we can't even show a friendly
    // message.
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    const response = await page.goto('/s/SPECTESTNOPE');
    expect(response?.status()).toBe(200);

    // App logo must render — proves the SPA booted rather than
    // Vercel serving its platform 404 HTML.
    await expect(page.getByRole('link', { name: /SWUTrade home/i })).toBeVisible({
      timeout: 10_000,
    });
    // And the "Not found" state surfaces within a reasonable poll
    // window (SessionView lands here when /api/sessions/<id>
    // returns 404 for the id).
    await expect(
      page.getByText(/doesn't exist|no longer available|not found/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Filter: the API 404 on a fake session id is expected and
    // surfaces as a browser resource warning. Treat that specific
    // shape as noise so the assertion targets real runtime errors
    // (React crashes, ErrorBoundary triggers) rather than the
    // expected not-found round-trip.
    const unexpected = errors.filter(msg =>
      !/Failed to load resource.*404.*Not Found/i.test(msg),
    );
    expect(unexpected).toEqual([]);
  });

  test('anonymous user clicks Live trade → QR canvas renders', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    // The button is always visible in the trade builder's action
    // strip regardless of auth — per the Phase 5b vision where
    // anonymous users can create sessions without a Discord account.
    const liveTradeBtn = page.getByRole('button', { name: /Live trade/i }).first();
    await expect(liveTradeBtn).toBeVisible({ timeout: 10_000 });
    await liveTradeBtn.click();

    // URL flips to /s/<code>. The code is 8 alphanumeric chars
    // from the session-id alphabet (see lib/sessions.ts).
    await expect(page).toHaveURL(/\/s\/[A-Z0-9]{8}$/, { timeout: 10_000 });

    // Creator view: "Waiting for your counterpart" panel with the
    // QR + copyable share URL.
    await expect(page.getByText(/Waiting for your counterpart/i)).toBeVisible({
      timeout: 10_000,
    });

    // QR canvas renders — `qrcode.react` emits an <svg>. Locating
    // by role `img` works because the component sets role="img" on
    // the root SVG. If the CJS interop regression comes back, this
    // fails because the whole component throws on render.
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 5_000 });

    // Share URL shown in the readonly input (so users can tap-and-
    // copy on mobile if the clipboard API is blocked). Match the
    // input value, not visible text — a readonly <input>'s value
    // isn't in the DOM text tree.
    const shareInput = page.locator('input[readonly]').first();
    await expect(shareInput).toHaveValue(/\/s\/[A-Z0-9]{8}$/);

    expect(errors).toEqual([]);
  });
});
