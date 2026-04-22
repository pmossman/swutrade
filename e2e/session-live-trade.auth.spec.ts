import { test, expect, expectNoConsoleErrors } from './_fixtures';

/**
 * Covers the Phase 5b shared-session invite flow end-to-end at the
 * browser layer (previously called "Live trade"; the button is now
 * "Invite someone"). Two bugs shipped through CI before this spec
 * existed:
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
test.describe('Invite-someone shared session', () => {
  // Both tests start from an anonymous context. Pre-dismiss the
  // first-run tutorial so its overlay doesn't intercept the
  // "Invite someone" click.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('swu.tour.dismissedAt', 'suppressed-by-e2e'); } catch {}
    });
  });

  test('GET /s/<unknown> renders the app chrome, not a 404', async ({ page, consoleErrors }) => {
    // Visiting any /s/<code> directly — even a made-up one — must
    // serve the SPA index so client routing can render the Not
    // Found state. The bug was that Vercel's default behaviour for
    // an unrewritten path is a literal 404 page from the platform,
    // so the SPA never boots and we can't even show a friendly
    // message.
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

    // Zero unexpected console errors — the fixture's default filter
    // strips out the expected API 404 + 401 noise, so anything
    // remaining is a real runtime error (React crash, ErrorBoundary
    // fire, unhandled promise rejection).
    expectNoConsoleErrors(consoleErrors);
  });

  test('anonymous user clicks Invite someone → QR canvas renders', async ({ page, consoleErrors }) => {
    await page.goto('/');
    // The button is always visible in the trade builder's action
    // strip regardless of auth — per the Phase 5b vision where
    // anonymous users can create sessions without a Discord account.
    // Labelled "Invite someone" — same placement + behaviour as the
    // earlier "Live trade", renamed to clarify its role now that
    // sessions live under the unified trade primitive.
    const inviteBtn = page.getByRole('button', { name: /Invite someone/i }).first();
    await expect(inviteBtn).toBeVisible({ timeout: 10_000 });
    await inviteBtn.click();

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

    expectNoConsoleErrors(consoleErrors);
  });

  test('ghost chrome collapses into guest UX — no sign-out, no ghost-home banner', async ({ page }) => {
    // Regression guard for the two-state user model: ghosts (anonymous
    // server cookie, minted by Invite someone / QR claim) used to see
    // a real-user AccountMenu with a "Sign out" entry and a dedicated
    // GhostHomeView with a gold "You're signed in as a guest" banner.
    // Both confused the IA — from the user's POV there are only two
    // states now: guest (signed-out OR ghost) vs Discord-signed-in.
    await page.goto('/');
    await page.getByRole('button', { name: /Invite someone/i }).first().click();
    await expect(page).toHaveURL(/\/s\/[A-Z0-9]{8}$/, { timeout: 10_000 });

    // Navigate back to `/` — the iron-session cookie was set by
    // create-open, so the next request is a bona-fide ghost.
    await page.goto('/');
    // Trade builder renders, not the old GhostHomeView.
    await expect(page.getByRole('button', { name: /Add cards to Offering/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/You're signed in as a guest/i)).toHaveCount(0);

    // AccountMenu shows guest variant: "Sign in with Discord" + no
    // "Sign out". The old real-user menu (Profile / Settings / Sign
    // out) is the tell that the UX was lying about ghost status.
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.getByRole('link', { name: /Sign in with Discord/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Sign out$/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Public profile/i })).toHaveCount(0);
    // Close the AccountMenu before interacting with NavMenu to avoid
    // accidental click-outside fires closing both.
    await page.keyboard.press('Escape');

    // NavMenu still surfaces My Trades (ghost has sessions) but NOT
    // My Communities (ghosts can't be enrolled in guilds).
    await page.getByRole('button', { name: 'Navigation menu' }).click();
    await expect(page.getByRole('link', { name: 'My Trades' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'My Communities' })).toHaveCount(0);
  });

  test('ghost visiting /?view=home falls back to trade builder', async ({ page }) => {
    // Even an explicit `?view=home` from a ghost routes to trade
    // builder — the home surface is real-user-only. The `home` route
    // rule in detectViewMode narrows to routingSignedIn (which excludes
    // ghosts), so ghost home requests fall through to 'trade'.
    await page.goto('/');
    await page.getByRole('button', { name: /Invite someone/i }).first().click();
    await expect(page).toHaveURL(/\/s\/[A-Z0-9]{8}$/, { timeout: 10_000 });

    await page.goto('/?view=home');
    await expect(page.getByRole('button', { name: /Add cards to Offering/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/You're signed in as a guest/i)).toHaveCount(0);
  });
});
