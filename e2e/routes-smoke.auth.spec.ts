import { test, expect, expectNoConsoleErrors } from './_fixtures';

/**
 * Smoke coverage for every public URL shape the app supports.
 *
 * The goal: catch vercel.json rewrite regressions + component-load
 * crashes BEFORE they reach production. Unit tests execute API
 * handlers directly and typecheck doesn't execute vercel.json at all,
 * so route config bugs slip past both layers. This spec is the
 * cheapest guard — each test does three things:
 *
 *   1. GET the URL. Status must be 200 (no platform 404 from a
 *      missing rewrite).
 *   2. App logo renders. Proves the SPA booted — rules out broken
 *      index.html serving and hard crashes at module load.
 *   3. Zero unexpected console errors. Filters out the expected
 *      401 / 404 noise from API probes for anonymous viewers, so
 *      anything remaining is a real bug (React crash, ErrorBoundary
 *      trigger, unhandled rejection).
 *
 * Anonymous viewer throughout — auth-gated pages surface a sign-in
 * wall or error state, which is fine: the smoke test only cares
 * that the page SERVES, not that it renders useful content. Deep
 * content-level assertions live in the per-flow specs.
 *
 * Every time a new rewrite lands in vercel.json or a new pathname
 * shape is added, extend this spec.
 */
test.describe('Routes smoke — all public URL shapes load', () => {
  // One row per URL we expect to serve the SPA entry. When adding
  // a new rewrite to vercel.json, add a matching row here.
  const routes: Array<{ label: string; path: string }> = [
    { label: 'home (bare root)',            path: '/' },
    { label: 'trade builder (explicit)',    path: '/?view=trade' },
    { label: 'list view (explicit)',        path: '/?view=list' },
    { label: 'home view (explicit)',        path: '/?view=home' },
    { label: 'trades history',              path: '/?trades=1' },
    { label: 'trade detail (unknown id)',   path: '/?trade=SPECTRADENOPE' },
    { label: 'profile (query form)',        path: '/?profile=specprofilenope' },
    { label: 'profile (pathname form)',     path: '/u/specprofilenope' },
    { label: 'settings',                    path: '/?settings=1' },
    { label: 'settings > tab',              path: '/?settings=1&tab=servers' },
    { label: 'community',                   path: '/?community=1' },
    { label: 'community > guild',           path: '/?community=1&guild=xyz' },
    { label: 'shared list (encoded)',       path: '/?view=list&w=AA' },
    { label: 'session (unknown code)',      path: '/s/SPECSESSIONNOPE' },
    { label: 'propose (unknown handle)',    path: '/?propose=specnobodyhere' },
    { label: 'counter (unknown id)',        path: '/?counter=SPECCOUNTERNOPE' },
    { label: 'edit (unknown id)',           path: '/?edit=SPECEDITNOPE' },
  ];

  for (const route of routes) {
    test(`${route.label} (${route.path})`, async ({ page, consoleErrors }) => {
      const response = await page.goto(route.path);
      expect(response?.status(), `${route.path} should serve 200`).toBe(200);

      // Page title is set by index.html unconditionally — proves
      // the SPA shell loaded rather than a platform error page. We
      // deliberately DON'T use the logo locator here: some view
      // error branches (e.g. ProfileView with an unknown handle)
      // render a minimal fallback without the AppHeader, and the
      // point of this spec is "the route serves," not "the view
      // rendered its happy path."
      await expect(page).toHaveTitle(/SWU ?Trade/i, { timeout: 10_000 });

      expectNoConsoleErrors(consoleErrors);
    });
  }
});
